import { join } from "node:path";
import { createCaptureStore } from "../../storage/capture/index.js";
import { RECONSTRUCTION_DIRECTORY, RECONSTRUCTION_JOB_KIND } from "../reconstruction/constants.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import { TRACING_ENGINE_FOREIGN_SESSION_MIN_AGE_MS } from "./constants.js";
export async function recoverTracingSessions(runtime, request) {
    const now = request.now ?? Date.now();
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()))
        throw new RangeError("Recovery time must be a valid timestamp");
    const minimumForeignAgeMs = request.minimumForeignAgeMs ?? TRACING_ENGINE_FOREIGN_SESSION_MIN_AGE_MS;
    if (!Number.isSafeInteger(minimumForeignAgeMs) || minimumForeignAgeMs < 0)
        throw new RangeError("Minimum foreign session age must be a non-negative integer");
    if (typeof request.optionsForSession !== "function")
        throw new TypeError("Session recovery options callback is required");
    const optionsForSession = request.optionsForSession;
    const lifecycleStore = createCaptureStore(runtime.storageRoot);
    const reconstructionStore = createCaptureStore(join(runtime.storageRoot, RECONSTRUCTION_DIRECTORY));
    const [lifecycleSessions, reconstructionSessions] = await Promise.all([
        lifecycleStore.enumerateSessions(runtime.integration),
        reconstructionStore.enumerateSessions(runtime.integration),
    ]);
    const writer = createLangSmithUploadWriter(runtime.writer);
    if (writer.accountFingerprint !== runtime.accountFingerprint)
        throw new Error("Recovery account fingerprint does not match the active session");
    const destinationIds = writer.destinations.map((destination) => destination.id);
    const lifecycleBySession = new Map(lifecycleSessions.map((entry) => [entry.sessionId, entry.captures]));
    const reconstructionBySession = new Map(reconstructionSessions.map((entry) => [entry.sessionId, entry.captures]));
    const sessionIds = new Set([
        ...lifecycleBySession.keys(),
        ...reconstructionBySession.keys(),
        runtime.currentSessionId,
    ]);
    const scheduled = [];
    const failed = [];
    for (const sessionId of [...sessionIds].toSorted()) {
        try {
            const lifecycleEntries = lifecycleBySession.get(sessionId) ?? [];
            const reconstructionEntries = reconstructionBySession.get(sessionId) ?? [];
            let hasLifecycleRecord = false;
            let hasPendingWork = false;
            let oldestPendingAtMs = Number.POSITIVE_INFINITY;
            let lastActivityAtMs = 0;
            for (const entry of lifecycleEntries) {
                const record = entry.record;
                if (record.destinationFingerprint !== runtime.accountFingerprint)
                    continue;
                hasLifecycleRecord = true;
                lastActivityAtMs = Math.max(lastActivityAtMs, entry.capturedAtMs);
                let pending = false;
                for (const destinationId of destinationIds) {
                    const outcome = await lifecycleStore.readOutcome({
                        integration: record.integration,
                        sessionId: record.sessionId,
                        turnId: record.turnId,
                        eventId: record.eventId,
                    }, destinationId);
                    if (outcome.status === "failed")
                        throw new Error(outcome.message);
                    if (outcome.status === "missing-capture")
                        throw new Error("Recovery capture disappeared");
                    if (outcome.status === "pending")
                        pending = true;
                    else
                        lastActivityAtMs = Math.max(lastActivityAtMs, new Date(outcome.receipt.recordedAt).getTime());
                }
                if (pending) {
                    hasPendingWork = true;
                    oldestPendingAtMs = Math.min(oldestPendingAtMs, entry.capturedAtMs);
                }
            }
            for (const entry of reconstructionEntries) {
                const record = entry.record;
                if (record.destinationFingerprint !== runtime.accountFingerprint)
                    continue;
                lastActivityAtMs = Math.max(lastActivityAtMs, entry.capturedAtMs);
                if (record.eventKind !== RECONSTRUCTION_JOB_KIND)
                    continue;
                const outcome = await reconstructionStore.readOutcome({
                    integration: record.integration,
                    sessionId: record.sessionId,
                    turnId: record.turnId,
                    eventId: record.eventId,
                }, runtime.accountFingerprint);
                if (outcome.status === "failed")
                    throw new Error(outcome.message);
                if (outcome.status === "missing-capture")
                    throw new Error("Recovery reconstruction job disappeared");
                if (outcome.status === "pending") {
                    hasPendingWork = true;
                    oldestPendingAtMs = Math.min(oldestPendingAtMs, entry.capturedAtMs);
                }
                else {
                    lastActivityAtMs = Math.max(lastActivityAtMs, new Date(outcome.receipt.recordedAt).getTime());
                }
            }
            const isCurrentSession = sessionId === runtime.currentSessionId;
            if (!hasLifecycleRecord && !hasPendingWork)
                continue;
            if (!isCurrentSession &&
                now - oldestPendingAtMs < minimumForeignAgeMs &&
                now - lastActivityAtMs < minimumForeignAgeMs) {
                continue;
            }
            if (isCurrentSession) {
                scheduled.push({ sessionId, status: await runtime.wakeCurrent() });
                continue;
            }
            const callbacks = await optionsForSession(sessionId);
            if (callbacks === null || typeof callbacks !== "object")
                throw new TypeError("Session recovery options must be an object");
            const sessionOptions = { ...callbacks, sessionId };
            const target = runtime.createSession(sessionOptions);
            scheduled.push({ sessionId, status: await target.wake() });
        }
        catch (error) {
            failed.push({
                sessionId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { scheduled, failed };
}
//# sourceMappingURL=recovery.js.map