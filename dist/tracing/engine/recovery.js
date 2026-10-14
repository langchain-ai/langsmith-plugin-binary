import { isWaitingForRetry } from "../../storage/capture/retry-state.js";
import { join } from "node:path";
import { createCaptureStore } from "../../storage/capture/index.js";
import { RECONSTRUCTION_DIRECTORY, RECONSTRUCTION_JOB_KIND } from "../reconstruction/constants.js";
import { LIFECYCLE_PATCH_EVENT_KIND, LIFECYCLE_POST_EVENT_KIND, LIFECYCLE_SETTLEMENT_EVENT_KIND, } from "../lifecycle/constants.js";
import { isWaitingForOtherSetting } from "../../storage/capture/account.js";
import { compareText } from "../../utils/compare.js";
import { fillTemplate } from "../../utils/format.js";
import { DELIVERY_ACCOUNT_MISMATCH_WARNING } from "../delivery/constants.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import { TRACING_ENGINE_BACKGROUND_RECOVERY_MINIMUM_AGE_ERROR, TRACING_ENGINE_FOREIGN_SESSION_MIN_AGE_MS, TRACING_ENGINE_RECOVERY_ACCOUNT_FINGERPRINT_DOES_NOT_MATCH_ACTIVE_SESSION_MESSAGE, TRACING_ENGINE_RECOVERY_MAX_FOREIGN_SESSIONS, TRACING_ENGINE_RECOVERY_TIME_MUST_BE_VALID_TIMESTAMP_MESSAGE, TRACING_ENGINE_SESSION_RECOVERY_OPTIONS_CALLBACK_IS_REQUIRED_MESSAGE, TRACING_ENGINE_SESSION_RECOVERY_OPTIONS_MUST_BE_OBJECT_MESSAGE, } from "./constants.js";
import { hasUnsettledRecoverySettlement } from "./recovery-settlement.js";
import { scopeKey } from "../../storage/capture/scope.js";
function validateRecoveryRequest(request) {
    const now = request.now ?? Date.now();
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()))
        throw new RangeError(TRACING_ENGINE_RECOVERY_TIME_MUST_BE_VALID_TIMESTAMP_MESSAGE);
    const minimumForeignAgeMs = request.minimumForeignAgeMs ?? TRACING_ENGINE_FOREIGN_SESSION_MIN_AGE_MS;
    if (!Number.isSafeInteger(minimumForeignAgeMs) || minimumForeignAgeMs < 0)
        throw new RangeError(TRACING_ENGINE_BACKGROUND_RECOVERY_MINIMUM_AGE_ERROR);
    if (typeof request.optionsForSession !== "function")
        throw new TypeError(TRACING_ENGINE_SESSION_RECOVERY_OPTIONS_CALLBACK_IS_REQUIRED_MESSAGE);
    return { now, minimumForeignAgeMs, optionsForSession: request.optionsForSession };
}
async function loadRecoveryIndex(runtime) {
    const lifecycleStore = createCaptureStore(runtime.storageRoot);
    const reconstructionStore = createCaptureStore(join(runtime.storageRoot, RECONSTRUCTION_DIRECTORY));
    const [lifecycleSessions, reconstructionSessions] = await Promise.all([
        lifecycleStore.enumerateSessions(runtime.integration),
        reconstructionStore.enumerateSessions(runtime.integration),
    ]);
    const writer = createLangSmithUploadWriter(runtime.writer);
    if (writer.accountFingerprint !== runtime.accountFingerprint)
        throw new Error(TRACING_ENGINE_RECOVERY_ACCOUNT_FINGERPRINT_DOES_NOT_MATCH_ACTIVE_SESSION_MESSAGE);
    return {
        lifecycleStore,
        writer,
        destinationIds: writer.destinations.map((destination) => destination.id),
        lifecycleBySession: new Map(lifecycleSessions.map((entry) => [entry.sessionId, entry.captures])),
        reconstructionBySession: new Map(reconstructionSessions.map((entry) => [entry.sessionId, entry.captures])),
        savedScopes: new Set(lifecycleSessions.flatMap(({ captures }) => captures.map(({ record }) => scopeKey(record)))),
        waitingForOtherSetting: lifecycleSessions
            .flatMap(({ captures }) => captures)
            .filter(({ record }) => isWaitingForOtherSetting(record, runtime.accountFingerprint)).length,
    };
}
function isDue(record, destinationId, now) {
    return (record.delivery?.outcomes[destinationId] === undefined &&
        !isWaitingForRetry(record.delivery?.retries[destinationId], now));
}
function isLifecycleKind(kind) {
    return (kind === LIFECYCLE_POST_EVENT_KIND ||
        kind === LIFECYCLE_PATCH_EVENT_KIND ||
        kind === LIFECYCLE_SETTLEMENT_EVENT_KIND);
}
async function assessSession(runtime, index, sessionId, now) {
    const ownEntries = (entries) => (entries ?? []).filter(({ record }) => record.destinationFingerprint === runtime.accountFingerprint);
    const lifecycle = ownEntries(index.lifecycleBySession.get(sessionId));
    const reconstruction = ownEntries(index.reconstructionBySession.get(sessionId));
    const pendingLifecycle = lifecycle.filter(({ record }) => index.destinationIds.some((id) => isDue(record, id, now)) &&
        (record.dependencies ?? []).every((dependency) => index.savedScopes.has(scopeKey(dependency))));
    const pendingJobs = reconstruction.filter(({ record }) => record.eventKind === RECONSTRUCTION_JOB_KIND &&
        isDue(record, runtime.accountFingerprint, now));
    const pending = [...pendingLifecycle, ...pendingJobs];
    const hasUnsettledTurn = lifecycle.some(({ record }) => !isLifecycleKind(record.eventKind)) ||
        (pendingLifecycle.length === 0 &&
            lifecycle.length > 0 &&
            (await hasUnsettledRecoverySettlement({
                captures: index.lifecycleBySession.get(sessionId) ?? [],
                integration: runtime.integration,
                sessionId,
                destinationFingerprint: runtime.accountFingerprint,
                destinations: index.writer.destinations,
                store: index.lifecycleStore,
            })));
    return {
        hasPendingWork: pending.length > 0,
        hasUnsettledTurn,
        lastActivityAtMs: Math.max(0, ...[...lifecycle, ...reconstruction].map((e) => e.modifiedAtMs)),
        oldestPendingAtMs: Math.min(Number.POSITIVE_INFINITY, ...pending.map(({ capturedAtMs }) => capturedAtMs)),
    };
}
async function wakeForeignSession(runtime, optionsForSession, sessionId, scopeGuard) {
    const callbacks = await optionsForSession(sessionId);
    if (callbacks === null || typeof callbacks !== "object")
        throw new TypeError(TRACING_ENGINE_SESSION_RECOVERY_OPTIONS_MUST_BE_OBJECT_MESSAGE);
    const sessionOptions = { ...callbacks, sessionId };
    const target = runtime.createSession(sessionOptions);
    if (scopeGuard && !(await scopeGuard()))
        return undefined;
    return { sessionId, status: await target.wake() };
}
function failureOf(sessionId, error) {
    return {
        sessionId,
        failed: { sessionId, message: error instanceof Error ? error.message : String(error) },
    };
}
function guardedStep(sessionId, wake) {
    return async () => {
        try {
            return { sessionId, scheduled: await wake() };
        }
        catch (error) {
            return failureOf(sessionId, error);
        }
    };
}
function oldestPendingFirst(left, right) {
    return (left.oldestPendingAtMs - right.oldestPendingAtMs || compareText(left.sessionId, right.sessionId));
}
async function planRecoverySteps(plan) {
    const { runtime, index, request, now, minimumForeignAgeMs, wakeForeign } = plan;
    const sessionIds = new Set([
        ...index.lifecycleBySession.keys(),
        ...index.reconstructionBySession.keys(),
        runtime.currentSessionId,
    ]);
    const steps = [];
    const foreign = [];
    for (const sessionId of [...sessionIds].toSorted()) {
        const isCurrentSession = sessionId === runtime.currentSessionId;
        if (request.excludeCurrentSession && isCurrentSession)
            continue;
        try {
            const assessment = await assessSession(runtime, index, sessionId, now);
            if (!assessment.hasUnsettledTurn && !assessment.hasPendingWork)
                continue;
            if (isCurrentSession) {
                steps.push(guardedStep(sessionId, async () => ({
                    sessionId,
                    status: await runtime.wakeCurrent(),
                })));
            }
            else if (Math.max(0, now - assessment.lastActivityAtMs) >= minimumForeignAgeMs) {
                foreign.push({ sessionId, oldestPendingAtMs: assessment.oldestPendingAtMs });
            }
        }
        catch (error) {
            steps.push(async () => failureOf(sessionId, error));
        }
    }
    for (const { sessionId } of foreign
        .toSorted(oldestPendingFirst)
        .slice(0, TRACING_ENGINE_RECOVERY_MAX_FOREIGN_SESSIONS))
        steps.push(guardedStep(sessionId, () => wakeForeign(sessionId)));
    return steps;
}
export async function recoverTracingSessions(runtime, request, scopeGuard) {
    const { now, minimumForeignAgeMs, optionsForSession } = validateRecoveryRequest(request);
    const index = await loadRecoveryIndex(runtime);
    if (index.waitingForOtherSetting > 0)
        console.warn(fillTemplate(DELIVERY_ACCOUNT_MISMATCH_WARNING, { count: index.waitingForOtherSetting }));
    const steps = await planRecoverySteps({
        runtime,
        index,
        request,
        now,
        minimumForeignAgeMs,
        wakeForeign: (id) => wakeForeignSession(runtime, optionsForSession, id, scopeGuard),
    });
    const results = await Promise.all(steps.map((step) => step()));
    const scheduled = [];
    const failed = [];
    for (const result of results) {
        if (result.failed !== undefined)
            failed.push(result.failed);
        else if (result.scheduled === undefined)
            return { scheduled, failed };
        else
            scheduled.push(result.scheduled);
    }
    return { scheduled, failed };
}
//# sourceMappingURL=recovery.js.map