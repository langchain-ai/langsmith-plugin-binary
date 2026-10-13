import { join, resolve } from "node:path";
import { tryAcquireFileLock } from "../../storage/index.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import { identifierHash } from "../../storage/capture/paths.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import { createDeliveryCoordinator } from "../delivery/index.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import { wakeCapturedWork } from "../capture-wake.js";
import { refreshSettlementProgress, settleCapturedTurns } from "../settlement/pass.js";
import { canonicalJsonObject, canonicalJsonValue, ownDataField, requireNonBlankString, requireNonNegativeInteger, requireOwnDataField, requirePlainRecord, requireSafeEpochMilliseconds, requireTimestamp, } from "../../utils/validation/objects.js";
import { snapshotData } from "../../utils/validation/snapshot.js";
import { LIFECYCLE_PATCH_EVENT_KIND, LIFECYCLE_POST_EVENT_KIND, LIFECYCLE_SETTLEMENT_LOCK_ACCOUNTS_DIRECTORY, LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY, LIFECYCLE_SETTLEMENT_LOCK_FILE, LIFECYCLE_SETTLEMENT_LOCK_INTEGRATIONS_DIRECTORY, LIFECYCLE_SETTLEMENT_LOCK_SESSIONS_DIRECTORY, } from "./constants.js";
import { projectSubmission, projectTurnEvidence } from "./projection.js";
import { captureLifecycleSnapshot } from "./snapshot.js";
import { compactSettledCaptures } from "./retention.js";
import { deriveAttributionReadiness, indexCaptureSources, withholdUnresolvedEndTime, } from "./closure.js";
export function createLifecycleBridge(options) {
    const integration = options.integration;
    const wake = options.wake;
    const sessionId = requireNonBlankString(options.sessionId, "Session ID");
    const storageRoot = resolve(options.storageRoot);
    const captureStore = createCaptureStore(storageRoot);
    const coordinator = createDeliveryCoordinator({
        storageRoot,
        integration,
        sessionId,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
    });
    const writer = createLangSmithUploadWriter(options.writer);
    const capture = async (input) => {
        const captureRecord = requirePlainRecord(snapshotData(requirePlainRecord(input, "Lifecycle capture")), "Lifecycle capture");
        const turnId = requireNonBlankString(captureRecord["turnId"], "Turn ID");
        const eventId = requireNonBlankString(captureRecord["eventId"], "Event ID");
        const sourceAge = ownDataField(captureRecord, "sourceAgeStartedAtMs");
        const sourceAgeStartedAtMs = sourceAge.present
            ? requireSafeEpochMilliseconds(sourceAge.value, "Source age")
            : undefined;
        const priorAttempts = ownDataField(captureRecord, "priorDeliveryAttempts");
        const priorDeliveryAttempts = priorAttempts.present
            ? requireNonNegativeInteger(priorAttempts.value, "Prior delivery attempts")
            : undefined;
        const scope = { integration, sessionId, turnId, eventId };
        const previous = await captureStore.read(scope);
        const projected = projectSubmission(captureRecord["submission"], integration, previous === undefined ? undefined : previousRunContext(previous));
        if (projected.status === "deferred") {
            return { status: "deferred", reason: "missing-thread-identity" };
        }
        const turnEvidence = projectTurnEvidence(captureRecord["turnEvidence"], projected.value.payload.privacyMode, deriveAttributionReadiness(captureRecord["submission"], integration));
        const dependencies = captureRecord["dependencies"];
        const identityPresence = projected.value.payload.operation === "post"
            ? suppliedRunIdentityFields(captureRecord["submission"])
            : undefined;
        const captureProjected = (value) => coordinator.capture({
            turnId,
            eventId,
            runId: value.payload.run.id,
            destinationFingerprint: writer.accountFingerprint,
            eventKind: value.payload.operation === "post"
                ? LIFECYCLE_POST_EVENT_KIND
                : LIFECYCLE_PATCH_EVENT_KIND,
            normalizedPayload: canonicalJsonValue(value.payload),
            turnEvidence,
            metadataProvenance: canonicalJsonValue(value.metadata),
            ...(sourceAgeStartedAtMs === undefined ? {} : { sourceAgeStartedAtMs }),
            ...(priorDeliveryAttempts === undefined ? {} : { priorDeliveryAttempts }),
            ...(dependencies === undefined ? {} : { dependencies }),
        });
        let result = await captureProjected(projected.value);
        if (result.status === "conflict" &&
            previous === undefined &&
            identityPresence !== undefined &&
            projected.value.payload.operation === "post") {
            const winner = await captureStore.read(scope);
            if (winner?.runId === projected.value.payload.run.id) {
                const run = { ...projected.value.payload.run };
                if (!identityPresence.startTime)
                    delete run.start_time;
                if (!identityPresence.traceId)
                    delete run.trace_id;
                if (!identityPresence.dottedOrder)
                    delete run.dotted_order;
                const retry = projectSubmission({ ...projected.value.payload, run, metadata: projected.value.metadata }, integration, previousRunContext(winner));
                if (retry.status === "ready")
                    result = await captureProjected(retry.value);
            }
        }
        if (result.status === "published" || result.status === "duplicate")
            await wakeCapturedWork(result, () => wake?.());
        return result;
    };
    return Object.freeze({
        accountFingerprint: writer.accountFingerprint,
        capture,
        captureSnapshot(input) {
            return captureLifecycleSnapshot({
                storageRoot,
                integration,
                sessionId,
                destinationFingerprint: writer.accountFingerprint,
                store: captureStore,
                capture,
                wake: async () => wake?.(),
            }, input);
        },
        async drain(input = {}) {
            const settlementLockDirectory = await ensurePrivateDirectory(storageRoot, [
                LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY,
                LIFECYCLE_SETTLEMENT_LOCK_INTEGRATIONS_DIRECTORY,
                integration,
                LIFECYCLE_SETTLEMENT_LOCK_SESSIONS_DIRECTORY,
                identifierHash(sessionId),
                LIFECYCLE_SETTLEMENT_LOCK_ACCOUNTS_DIRECTORY,
                identifierHash(writer.accountFingerprint),
            ]);
            const settlementLock = await tryAcquireFileLock(join(settlementLockDirectory, LIFECYCLE_SETTLEMENT_LOCK_FILE));
            if (settlementLock === undefined)
                return { status: "busy", settlement: { captured: 0, turns: [] } };
            let drainResult;
            try {
                const drainOnce = async () => {
                    const sourceSnapshot = (await captureStore.enumerate(integration, sessionId)).map(({ record }) => record);
                    const sourceByScope = indexCaptureSources(sourceSnapshot);
                    return coordinator.drain({
                        writer: {
                            accountFingerprint: writer.accountFingerprint,
                            destinations: writer.destinations,
                            async send(record, destination, fingerprint) {
                                if (fingerprint !== writer.accountFingerprint)
                                    throw new Error("Upload account changed");
                                const submission = restoreSubmission(record, integration);
                                const outgoing = await withholdUnresolvedEndTime({
                                    record,
                                    submission,
                                    sourceSnapshot,
                                    sourceByScope,
                                    integration,
                                    destinations: writer.destinations,
                                    readOutcome: (scope, destinationId) => captureStore.readOutcome(scope, destinationId),
                                });
                                await writer.send(outgoing, destination.id);
                            },
                        },
                        ...(input.now === undefined ? {} : { now: input.now }),
                    });
                };
                const first = await drainOnce();
                if (first.status === "busy")
                    return { status: "busy", settlement: { captured: 0, turns: [] } };
                const readOutcome = (scope, destination) => captureStore.readOutcome(scope, destination);
                const settlementCaptures = await captureStore.enumerate(integration, sessionId);
                const work = await settleCapturedTurns({
                    captures: settlementCaptures,
                    integration,
                    sessionId,
                    destinationFingerprint: writer.accountFingerprint,
                    destinations: writer.destinations,
                    capture: (captureInput) => coordinator.capture(captureInput),
                    readOutcome,
                });
                let result = first;
                if (work.progress.captured > 0) {
                    const second = await drainOnce();
                    if (second.status === "drained") {
                        result = {
                            status: "drained",
                            delivered: first.delivered + second.delivered,
                            dropped: first.dropped + second.dropped,
                            failed: first.failed + second.failed,
                            pending: second.pending,
                            accountMismatch: second.accountMismatch,
                        };
                    }
                }
                const settlement = await refreshSettlementProgress(work, writer.destinations, readOutcome);
                await compactSettledCaptures({
                    storageRoot,
                    integration,
                    sessionId,
                    destinationFingerprint: writer.accountFingerprint,
                    store: captureStore,
                    destinations: writer.destinations,
                    settledTurnIds: settlement.turns
                        .filter((entry) => entry.status === "settled")
                        .map((entry) => entry.turnId),
                    eligibleCaptures: settlementCaptures,
                    readOutcome,
                });
                drainResult = { ...result, settlement };
            }
            finally {
                await settlementLock.release();
            }
            if (drainResult.status === "drained" && drainResult.delivered + drainResult.dropped > 0) {
                await wake?.();
            }
            return drainResult;
        },
    });
}
function suppliedRunIdentityFields(value) {
    const source = requirePlainRecord(value, "Prepared run submission");
    const run = requirePlainRecord(requireOwnDataField(source, "run"), "Normalized run snapshot");
    const supplied = (key) => {
        const field = ownDataField(run, key);
        return field.present && field.value !== undefined;
    };
    return {
        startTime: supplied("start_time"),
        traceId: supplied("trace_id"),
        dottedOrder: supplied("dotted_order"),
    };
}
function previousRunContext(record) {
    const payload = requirePlainRecord(record.normalizedPayload, "Stored run payload");
    const runField = ownDataField(payload, "run");
    if (!runField.present)
        throw new TypeError("Stored run context is required");
    const run = requirePlainRecord(runField.value, "Stored run context");
    const context = {
        id: requireNonBlankString(run["id"], "Run ID"),
        name: requireNonBlankString(run["name"], "Run name"),
        run_type: requireNonBlankString(run["run_type"], "Run type"),
    };
    const startTime = ownDataField(run, "start_time");
    if (startTime.present && startTime.value !== undefined)
        context.start_time = requireTimestamp(startTime.value);
    const parentRunId = ownDataField(run, "parent_run_id");
    if (parentRunId.present && parentRunId.value !== undefined) {
        context.parent_run_id = requireNonBlankString(parentRunId.value, "Parent run ID");
    }
    const traceId = ownDataField(run, "trace_id");
    if (traceId.present && traceId.value !== undefined) {
        context.trace_id = requireNonBlankString(traceId.value, "Trace ID");
    }
    const dottedOrder = ownDataField(run, "dotted_order");
    if (dottedOrder.present && dottedOrder.value !== undefined) {
        context.dotted_order = requireNonBlankString(dottedOrder.value, "Dotted order");
    }
    return context;
}
function restoreSubmission(record, integration) {
    if (record.compaction !== undefined)
        throw new TypeError("Compacted capture data cannot be restored for delivery");
    const payload = canonicalJsonObject(record.normalizedPayload, "Stored run payload");
    if (payload["integration"] !== integration)
        throw new TypeError("Stored integration does not match the lifecycle bridge");
    if (payload["run"] === null || typeof payload["run"] !== "object") {
        throw new TypeError("Stored run data is required");
    }
    const run = payload["run"];
    if (run["id"] !== record.runId)
        throw new TypeError("Stored run ID does not match its capture");
    const mode = payload["privacyMode"];
    if (mode !== "full" && mode !== "metadata")
        throw new TypeError("Stored privacy mode is invalid");
    const projected = projectSubmission({ ...payload, metadata: record.metadataProvenance }, integration);
    if (projected.status === "deferred")
        throw new TypeError("Stored capture is missing thread identity");
    return { ...projected.value.payload, metadata: projected.value.metadata };
}
//# sourceMappingURL=bridge.js.map