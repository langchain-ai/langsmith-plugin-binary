import { join, resolve } from "node:path";
import { tryAcquireFileLock } from "../../storage/index.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import { identifierHash, validateIdentifier, validateIntegration, } from "../../storage/capture/paths.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import { createDeliveryAttemptStore } from "../delivery/attempt-store.js";
import { DELIVERY_CAPACITY_REASON, DELIVERY_DEFAULT_MAX_AGE_MS, DELIVERY_DEFAULT_MAX_ATTEMPTS, DELIVERY_DEFAULT_MAX_ENTRIES, DELIVERY_EXPIRED_REASON, DELIVERY_RETRY_EXHAUSTED_REASON, } from "../delivery/constants.js";
import { canonicalJson, canonicalValue } from "../../storage/capture/utils/serialization.js";
import { canonicalJsonObject, ownDataField, requireBoolean, requireNonBlankString, requireOwnDataField, requirePlainRecord, requireSafeEpochMilliseconds, requireStringArray, } from "../../utils/validation/objects.js";
import { snapshotData } from "../../utils/validation/snapshot.js";
import { projectSubmission } from "../lifecycle/projection.js";
import { RECONSTRUCTION_ATTRIBUTION_CONTEXT_KEYS, RECONSTRUCTION_ATTRIBUTION_CONTEXT_OPTIONAL_KEYS, RECONSTRUCTION_CLOSURE_STATES, RECONSTRUCTION_DEFERRED_REASON, RECONSTRUCTION_DEPENDENCY_KEYS, RECONSTRUCTION_DRAIN_LOCK, RECONSTRUCTION_DIRECTORY, RECONSTRUCTION_JOB_INPUT_KEYS, RECONSTRUCTION_JOB_OPTIONAL_INPUT_KEYS, RECONSTRUCTION_JOB_KIND, RECONSTRUCTION_MAPPING_KIND, RECONSTRUCTION_RECORD_VERSION, RECONSTRUCTION_MAPPING_EVENT_ID_PREFIX, RECONSTRUCTION_RUN_ID_PREFIX, RECONSTRUCTION_OUTPUT_KEYS, RECONSTRUCTION_OUTPUT_OPTIONAL_KEYS, RECONSTRUCTION_SOURCE_SNAPSHOT_KEYS, RECONSTRUCTION_SOURCE_SNAPSHOT_OPTIONAL_KEYS, RECONSTRUCTION_SESSIONS_DIRECTORY, RECONSTRUCTION_STORED_JOB_KEYS, RECONSTRUCTION_STORED_JOB_OPTIONAL_KEYS, RECONSTRUCTION_TOOL_ORIGIN_KEYS, RECONSTRUCTION_TOOL_ORIGIN_OPTIONAL_KEYS, RECONSTRUCTION_TURN_EVIDENCE_KEYS, RECONSTRUCTION_TURN_EVIDENCE_KEYS_WITH_ROOT, RECONSTRUCTION_WORKER_DIRECTORY, } from "./constants.js";
export function createReconstructionWorker(options) {
    const integration = options.integration;
    const sessionId = requireNonBlankString(options.sessionId, "Session ID");
    const accountFingerprint = requireNonBlankString(options.bridge.accountFingerprint, "Account fingerprint");
    const bridge = Object.freeze({ accountFingerprint, capture: options.bridge.capture });
    const reconstruct = options.reconstruct;
    if (typeof bridge.capture !== "function" || typeof reconstruct !== "function")
        throw new TypeError("Reconstruction callbacks are required");
    validateIntegration(integration);
    validateIdentifier(sessionId, "session ID");
    validateIdentifier(accountFingerprint, "account fingerprint");
    const policy = resolvePolicy(options.policy);
    const storageRoot = join(resolve(options.storageRoot), RECONSTRUCTION_DIRECTORY);
    const captureStore = createCaptureStore(storageRoot);
    const attemptStore = createDeliveryAttemptStore(storageRoot);
    return {
        async enqueue(input) {
            const job = validateJobInput(input, integration, sessionId, accountFingerprint);
            return captureStore.capture(jobRecord(job));
        },
        async drain(request = {}) {
            const now = request.now ?? Date.now();
            if (!Number.isFinite(now))
                throw new RangeError("Drain time must be finite");
            const lockDirectory = await ensurePrivateDirectory(storageRoot, [
                RECONSTRUCTION_WORKER_DIRECTORY,
                integration,
                RECONSTRUCTION_SESSIONS_DIRECTORY,
                identifierHash(sessionId),
            ]);
            const lock = await tryAcquireFileLock(join(lockDirectory, RECONSTRUCTION_DRAIN_LOCK));
            if (!lock)
                return { status: "busy" };
            const counts = { captured: 0, deferred: 0, failed: 0, dropped: 0 };
            try {
                const entries = await captureStore.enumerate(integration, sessionId);
                const candidates = [];
                for (const entry of entries) {
                    if (entry.record.eventKind === RECONSTRUCTION_MAPPING_KIND) {
                        readMapping(entry.record);
                        continue;
                    }
                    if (entry.record.eventKind !== RECONSTRUCTION_JOB_KIND)
                        throw new Error("Unsupported reconstruction record");
                    const job = readJob(entry.record, integration);
                    const scope = scopeOf(entry.record);
                    const outcome = await captureStore.readOutcome(scope, job.accountFingerprint);
                    if (outcome.status === "failed")
                        throw new Error(outcome.message);
                    if (outcome.status === "missing-capture")
                        throw new Error("Reconstruction job disappeared");
                    if (outcome.status === "settled")
                        continue;
                    if (job.accountFingerprint !== accountFingerprint)
                        continue;
                    if (now - jobAgeStartedAtMs(job, entry.capturedAtMs) >= policy.maxAgeMs) {
                        counts.dropped += Number(await recordTerminal(captureStore, scope, job.accountFingerprint, "dropped", DELIVERY_EXPIRED_REASON));
                        continue;
                    }
                    candidates.push({ entry, job, scope });
                }
                const overCapacity = Math.max(0, candidates.length - policy.maxEntries);
                for (const candidate of candidates.slice(0, overCapacity)) {
                    counts.dropped += Number(await recordTerminal(captureStore, candidate.scope, candidate.job.accountFingerprint, "dropped", DELIVERY_CAPACITY_REASON));
                }
                for (const candidate of candidates.slice(overCapacity)) {
                    const result = await processJob(candidate.job, candidate.entry.capturedAtMs, candidate.scope, reconstruct, bridge, captureStore, attemptStore, policy.maxAttempts, counts);
                    if (result === "deferred")
                        counts.deferred += 1;
                }
            }
            finally {
                await lock.release();
            }
            const finalEntries = await captureStore.enumerate(integration, sessionId);
            let pending = 0;
            let accountMismatch = 0;
            for (const entry of finalEntries) {
                if (entry.record.eventKind !== RECONSTRUCTION_JOB_KIND)
                    continue;
                const job = readJob(entry.record, integration);
                const outcome = await captureStore.readOutcome(scopeOf(entry.record), job.accountFingerprint);
                if (outcome.status === "failed")
                    throw new Error(outcome.message);
                if (outcome.status !== "settled") {
                    pending += 1;
                    if (job.accountFingerprint !== accountFingerprint)
                        accountMismatch += 1;
                }
            }
            return { status: "drained", ...counts, pending, accountMismatch };
        },
    };
}
async function processJob(job, jobCapturedAtMs, scope, reconstruct, bridge, store, attempts, maxAttempts, counts) {
    const attemptCount = await attempts.count(scope, job.accountFingerprint);
    if (attemptCount >= maxAttempts) {
        counts.dropped += Number(await recordTerminal(store, scope, job.accountFingerprint, "dropped", DELIVERY_RETRY_EXHAUSTED_REASON));
        return "complete";
    }
    let interpretation;
    try {
        const result = requirePlainRecord(await reconstruct(snapshotJob(job)), "Reconstruction result");
        const status = requireOwnDataField(result, "status");
        if (status === "deferred") {
            if (requireOwnDataField(result, "reason") !== RECONSTRUCTION_DEFERRED_REASON)
                throw new TypeError("Invalid reconstruction deferral reason");
            return "deferred";
        }
        if (status !== "ready")
            throw new TypeError("Invalid reconstruction result status");
        interpretation = {
            status,
            outputs: requireOwnDataField(result, "outputs"),
        };
    }
    catch {
        await recordFailure(store, attempts, scope, job.accountFingerprint, maxAttempts, counts);
        return "complete";
    }
    let outputs;
    try {
        outputs = validateOutputs(interpretation.outputs, job, jobCapturedAtMs);
        if (outputs.length === 0)
            throw new TypeError("Reconstruction produced no captures");
    }
    catch {
        await recordFailure(store, attempts, scope, job.accountFingerprint, maxAttempts, counts);
        return "complete";
    }
    const mappingInput = mappingRecord(job, outputs);
    const mappingResult = await store.capture(mappingInput);
    if (mappingResult.status !== "published" && mappingResult.status !== "duplicate") {
        await recordFailure(store, attempts, scope, job.accountFingerprint, maxAttempts, counts);
        return "complete";
    }
    const storedMapping = readMapping(mappingResult.record);
    if (storedMapping.jobEventId !== job.eventId || !sameOutputMapping(storedMapping, outputs)) {
        await recordFailure(store, attempts, scope, job.accountFingerprint, maxAttempts, counts);
        return "complete";
    }
    for (const output of outputs) {
        const turnEvidence = {
            ...(job.turnEvidence.rootRunId === undefined
                ? {}
                : { rootRunId: job.turnEvidence.rootRunId }),
            childRunIds: [...job.turnEvidence.childRunIds],
            closureState: job.turnEvidence.closureState,
        };
        const captureInput = {
            turnId: job.turnId,
            eventId: output.eventId,
            submission: output.submission,
            turnEvidence,
            ...(output.dependencies === undefined ? {} : { dependencies: output.dependencies }),
            ...(output.sourceAgeStartedAtMs === undefined
                ? {}
                : { sourceAgeStartedAtMs: output.sourceAgeStartedAtMs }),
        };
        let captureStatus;
        try {
            captureStatus = requireOwnDataField(requirePlainRecord(await bridge.capture(captureInput), "Lifecycle capture result"), "status");
        }
        catch {
            await recordFailure(store, attempts, scope, job.accountFingerprint, maxAttempts, counts);
            return "complete";
        }
        if (captureStatus === "deferred")
            return "deferred";
        if (captureStatus !== "published" && captureStatus !== "duplicate") {
            await recordFailure(store, attempts, scope, job.accountFingerprint, maxAttempts, counts);
            return "complete";
        }
        if (captureStatus === "published")
            counts.captured += 1;
    }
    await recordTerminal(store, scope, job.accountFingerprint, "delivered");
    return "complete";
}
async function recordFailure(store, attempts, scope, accountFingerprint, maxAttempts, counts) {
    const nextAttempt = (await attempts.count(scope, accountFingerprint)) + 1;
    await attempts.record(scope, accountFingerprint, nextAttempt, new Date().toISOString());
    counts.failed += 1;
    if (nextAttempt >= maxAttempts) {
        counts.dropped += Number(await recordTerminal(store, scope, accountFingerprint, "dropped", DELIVERY_RETRY_EXHAUSTED_REASON));
    }
}
async function recordTerminal(store, scope, accountFingerprint, outcome, reason) {
    const result = await store.recordOutcome({
        ...scope,
        destination: accountFingerprint,
        outcome,
        ...(outcome === "dropped" ? { reason: reason ?? DELIVERY_RETRY_EXHAUSTED_REASON } : {}),
    });
    if (result.status !== "recorded" && result.status !== "duplicate")
        throw new Error(`Could not record terminal reconstruction outcome: ${result.status}`);
    return result.status === "recorded";
}
function snapshotJob(job) {
    return Object.freeze({
        ...job,
        sourceRefs: Object.freeze([...job.sourceRefs]),
        ...(job.sourceSnapshots === undefined
            ? {}
            : {
                sourceSnapshots: Object.freeze(job.sourceSnapshots.map((snapshot) => Object.freeze({
                    ...snapshot,
                    submission: snapshotData(snapshot.submission),
                    ...(snapshot.attributionContext === undefined
                        ? {}
                        : {
                            attributionContext: Object.freeze({
                                toolOrigin: Object.freeze({ ...snapshot.attributionContext.toolOrigin }),
                                ...(snapshot.attributionContext.pinnedRepositoryKeys === undefined
                                    ? {}
                                    : {
                                        pinnedRepositoryKeys: Object.freeze([
                                            ...snapshot.attributionContext.pinnedRepositoryKeys,
                                        ]),
                                    }),
                            }),
                        }),
                }))),
            }),
        turnEvidence: Object.freeze({
            ...(job.turnEvidence.rootRunId === undefined
                ? {}
                : { rootRunId: job.turnEvidence.rootRunId }),
            childRunIds: Object.freeze([...job.turnEvidence.childRunIds]),
            closureState: job.turnEvidence.closureState,
        }),
    });
}
function jobAgeStartedAtMs(job, capturedAtMs) {
    if (job.sourceSnapshots !== undefined) {
        return Math.min(...job.sourceSnapshots.map(({ sourceAgeStartedAtMs }) => sourceAgeStartedAtMs));
    }
    return job.sourceAgeStartedAtMs ?? capturedAtMs;
}
function resolvePolicy(policy) {
    const resolved = {
        maxAttempts: policy?.maxAttempts ?? DELIVERY_DEFAULT_MAX_ATTEMPTS,
        maxAgeMs: policy?.maxAgeMs ?? DELIVERY_DEFAULT_MAX_AGE_MS,
        maxEntries: policy?.maxEntries ?? DELIVERY_DEFAULT_MAX_ENTRIES,
    };
    if (!Number.isSafeInteger(resolved.maxAttempts) ||
        resolved.maxAttempts <= 0 ||
        !Number.isSafeInteger(resolved.maxAgeMs) ||
        resolved.maxAgeMs <= 0 ||
        !Number.isSafeInteger(resolved.maxEntries) ||
        resolved.maxEntries <= 0) {
        throw new TypeError("Invalid delivery policy");
    }
    return resolved;
}
function validateOutputs(value, job, jobCapturedAtMs) {
    if (!Array.isArray(value))
        throw new TypeError("Reconstruction outputs must be an array");
    const seen = new Set();
    return value.map((item) => {
        const output = requirePlainRecord(item, "Reconstruction output");
        const outputKeys = Object.keys(output).toSorted();
        if (RECONSTRUCTION_OUTPUT_KEYS.some((key) => !outputKeys.includes(key)) ||
            outputKeys.some((key) => !RECONSTRUCTION_OUTPUT_KEYS.includes(key) &&
                !RECONSTRUCTION_OUTPUT_OPTIONAL_KEYS.includes(key))) {
            throw new TypeError("Reconstruction output has unsupported fields");
        }
        const eventId = requireNonBlankString(requireOwnDataField(output, "eventId"), "Event ID");
        validateIdentifier(eventId, "event ID");
        if (seen.has(eventId))
            throw new TypeError("Reconstruction event IDs must be unique");
        seen.add(eventId);
        const submissionValue = canonicalJsonObject(requirePlainRecord(requireOwnDataField(output, "submission"), "Reconstruction submission"), "Reconstruction submission");
        const integration = requireNonBlankString(requireOwnDataField(submissionValue, "integration"), "Integration");
        if (integration !== job.integration)
            throw new TypeError("Reconstruction integration changed");
        const privacyMode = requireOwnDataField(submissionValue, "privacyMode");
        if (privacyMode !== "full" && privacyMode !== "metadata")
            throw new TypeError("Reconstruction privacy mode is invalid");
        if (job.privacyMode === "metadata" && privacyMode === "full")
            throw new TypeError("Metadata reconstruction cannot emit full-mode captures");
        const run = requirePlainRecord(requireOwnDataField(submissionValue, "run"), "Run");
        const runId = requireNonBlankString(requireOwnDataField(run, "id"), "Run ID");
        validateIdentifier(runId, "run ID");
        const dependenciesValue = ownDataField(output, "dependencies");
        let dependencies;
        if (dependenciesValue.present) {
            if (!Array.isArray(dependenciesValue.value))
                throw new TypeError("Reconstruction dependencies must be an array");
            dependencies = validateDependencies(dependenciesValue.value, job, eventId);
        }
        const sourceRefField = ownDataField(output, "sourceRef");
        let sourceRef;
        let sourceAgeStartedAtMs;
        if (sourceRefField.present) {
            sourceRef = requireNonBlankString(sourceRefField.value, "Source ref");
            validateIdentifier(sourceRef, "source ref");
        }
        if (job.sourceSnapshots !== undefined) {
            if (sourceRef === undefined)
                throw new TypeError("Snapshot outputs require a source ref");
            const snapshot = job.sourceSnapshots.find((candidate) => candidate.sourceRef === sourceRef);
            if (snapshot === undefined)
                throw new TypeError("Output source ref has no snapshot");
            sourceAgeStartedAtMs = snapshot.sourceAgeStartedAtMs;
        }
        else if (sourceRef !== undefined) {
            if (!job.sourceRefs.includes(sourceRef))
                throw new TypeError("Output source ref is not in the reconstruction job");
            sourceAgeStartedAtMs = job.sourceAgeStartedAtMs ?? jobCapturedAtMs;
        }
        else {
            sourceAgeStartedAtMs = job.sourceAgeStartedAtMs ?? jobCapturedAtMs;
        }
        return {
            eventId,
            runId,
            submission: submissionValue,
            ...(sourceRef === undefined ? {} : { sourceRef }),
            ...(sourceAgeStartedAtMs === undefined ? {} : { sourceAgeStartedAtMs }),
            ...(dependencies === undefined ? {} : { dependencies }),
        };
    });
}
function validateDependencies(value, job, eventId) {
    if (!Array.isArray(value))
        throw new TypeError("Reconstruction dependencies must be an array");
    const dependent = { ...scopeOf(job), eventId };
    const seen = new Set();
    return value.map((item) => {
        const source = requirePlainRecord(item, "Reconstruction dependency");
        const keys = Object.keys(source).toSorted();
        if (canonicalJson(keys) !== canonicalJson(RECONSTRUCTION_DEPENDENCY_KEYS))
            throw new TypeError("Reconstruction dependencies must contain only capture scopes");
        const integration = requireNonBlankString(requireOwnDataField(source, "integration"), "Dependency integration");
        if (integration !== job.integration)
            throw new TypeError("Reconstruction dependencies must use the same integration");
        const scope = {
            integration,
            sessionId: requireNonBlankString(requireOwnDataField(source, "sessionId"), "Dependency session ID"),
            turnId: requireNonBlankString(requireOwnDataField(source, "turnId"), "Dependency turn ID"),
            eventId: requireNonBlankString(requireOwnDataField(source, "eventId"), "Dependency event ID"),
        };
        validateIdentifier(scope.sessionId, "dependency session ID");
        validateIdentifier(scope.turnId, "dependency turn ID");
        validateIdentifier(scope.eventId, "dependency event ID");
        if (scope.sessionId === dependent.sessionId &&
            scope.turnId === dependent.turnId &&
            scope.eventId === dependent.eventId) {
            throw new TypeError("Reconstruction captures cannot depend on themselves");
        }
        const key = canonicalJson(scope);
        if (seen.has(key))
            throw new TypeError("Reconstruction dependencies must be unique");
        seen.add(key);
        return scope;
    });
}
function validateJobInput(value, integration, sessionId, accountFingerprint) {
    const input = requirePlainRecord(snapshotData(requirePlainRecord(value, "Reconstruction job")), "Reconstruction job");
    const keys = Object.keys(input).toSorted();
    if (RECONSTRUCTION_JOB_INPUT_KEYS.some((key) => !keys.includes(key)) ||
        keys.some((key) => !RECONSTRUCTION_JOB_INPUT_KEYS.includes(key) &&
            !RECONSTRUCTION_JOB_OPTIONAL_INPUT_KEYS.includes(key))) {
        throw new TypeError("Reconstruction job has unsupported fields");
    }
    const turnId = requireNonBlankString(requireOwnDataField(input, "turnId"), "Turn ID");
    const eventId = requireNonBlankString(requireOwnDataField(input, "eventId"), "Event ID");
    validateIdentifier(turnId, "turn ID");
    validateIdentifier(eventId, "event ID");
    const privacyMode = requireOwnDataField(input, "privacyMode");
    if (privacyMode !== "full" && privacyMode !== "metadata")
        throw new TypeError("Reconstruction privacy mode is invalid");
    const sourceRefs = requireStringArray(requireOwnDataField(input, "sourceRefs"), "Source refs");
    if (sourceRefs.length === 0)
        throw new TypeError("Reconstruction source refs are required");
    if (new Set(sourceRefs).size !== sourceRefs.length)
        throw new TypeError("Reconstruction source refs must be unique");
    for (const ref of sourceRefs) {
        requireNonBlankString(ref, "Source ref");
        validateIdentifier(ref, "source ref");
    }
    const turnEvidence = validateTurnEvidence(requireOwnDataField(input, "turnEvidence"));
    const sourceSnapshotsField = ownDataField(input, "sourceSnapshots");
    const sourceAgeField = ownDataField(input, "sourceAgeStartedAtMs");
    if (sourceSnapshotsField.present && sourceAgeField.present)
        throw new TypeError("Reconstruction jobs cannot combine snapshots with a job-level source age");
    const sourceAgeStartedAtMs = sourceAgeField.present
        ? requireSafeEpochMilliseconds(sourceAgeField.value, "Source age")
        : undefined;
    const sourceSnapshots = sourceSnapshotsField.present
        ? validateSourceSnapshots(sourceSnapshotsField.value, integration, privacyMode, sourceRefs)
        : undefined;
    return {
        integration,
        sessionId,
        turnId,
        eventId,
        accountFingerprint,
        sourceRefs,
        privacyMode,
        turnEvidence,
        ...(sourceSnapshots === undefined ? {} : { sourceSnapshots }),
        ...(sourceAgeStartedAtMs === undefined ? {} : { sourceAgeStartedAtMs }),
    };
}
function validateSourceSnapshots(value, integration, privacyMode, sourceRefs) {
    if (!Array.isArray(value) || value.length === 0)
        throw new TypeError("Reconstruction source snapshots must be a nonempty array");
    for (const ref of sourceRefs)
        validatePathlessSourceRef(ref);
    const seen = new Set();
    const snapshots = value.map((item) => {
        const source = requirePlainRecord(item, "Reconstruction source snapshot");
        const keys = Object.keys(source).toSorted();
        if (RECONSTRUCTION_SOURCE_SNAPSHOT_KEYS.some((key) => !keys.includes(key)) ||
            keys.some((key) => !RECONSTRUCTION_SOURCE_SNAPSHOT_KEYS.includes(key) &&
                !RECONSTRUCTION_SOURCE_SNAPSHOT_OPTIONAL_KEYS.includes(key))) {
            throw new TypeError("Reconstruction source snapshot has unsupported fields");
        }
        const sourceRef = requireNonBlankString(requireOwnDataField(source, "sourceRef"), "Source ref");
        validatePathlessSourceRef(sourceRef);
        if (!sourceRefs.includes(sourceRef))
            throw new TypeError("Reconstruction snapshot ref must belong to the job");
        if (seen.has(sourceRef))
            throw new TypeError("Reconstruction snapshot refs must be unique");
        seen.add(sourceRef);
        const sourceAgeStartedAtMs = requireSafeEpochMilliseconds(requireOwnDataField(source, "sourceAgeStartedAtMs"), "Source age");
        const submission = canonicalJsonObject(requirePlainRecord(requireOwnDataField(source, "submission"), "Prepared submission"), "Prepared submission");
        if (requireOwnDataField(submission, "privacyMode") !== privacyMode)
            throw new TypeError("Snapshot privacy mode must match the reconstruction job");
        if (submission["operation"] === "post") {
            const run = requirePlainRecord(requireOwnDataField(submission, "run"), "Prepared run");
            if (!ownDataField(run, "start_time").present)
                throw new TypeError("Source snapshot posts must preserve their start time");
        }
        const projected = projectSubmission(submission, integration);
        if (projected.status !== "ready")
            throw new TypeError("Reconstruction snapshots must be ready for shared projection");
        const projectedSubmission = canonicalJsonObject({ ...projected.value.payload, metadata: projected.value.metadata }, "Projected submission");
        const attributionField = ownDataField(source, "attributionContext");
        const attributionContext = attributionField.present
            ? validateAttributionContext(attributionField.value, privacyMode)
            : undefined;
        return {
            sourceRef,
            submission: projectedSubmission,
            sourceAgeStartedAtMs,
            ...(attributionContext === undefined ? {} : { attributionContext }),
        };
    });
    if (snapshots.length !== sourceRefs.length)
        throw new TypeError("Source snapshots must cover every reconstruction source ref");
    return snapshots;
}
function validatePathlessSourceRef(sourceRef) {
    validateIdentifier(sourceRef, "source ref");
    if (sourceRef.includes("/") || sourceRef.includes("\\"))
        throw new TypeError("Snapshot source refs must be pathless identifiers");
}
function validateAttributionContext(value, privacyMode) {
    const context = requirePlainRecord(value, "Attribution context");
    const keys = Object.keys(context).toSorted();
    if (RECONSTRUCTION_ATTRIBUTION_CONTEXT_KEYS.some((key) => !keys.includes(key)) ||
        keys.some((key) => !RECONSTRUCTION_ATTRIBUTION_CONTEXT_KEYS.includes(key) &&
            !RECONSTRUCTION_ATTRIBUTION_CONTEXT_OPTIONAL_KEYS.includes(key))) {
        throw new TypeError("Attribution context has unsupported fields");
    }
    const origin = requirePlainRecord(requireOwnDataField(context, "toolOrigin"), "Tool origin");
    const originKeys = Object.keys(origin).toSorted();
    if (RECONSTRUCTION_TOOL_ORIGIN_KEYS.some((key) => !originKeys.includes(key)) ||
        originKeys.some((key) => !RECONSTRUCTION_TOOL_ORIGIN_KEYS.includes(key) &&
            !RECONSTRUCTION_TOOL_ORIGIN_OPTIONAL_KEYS.includes(key))) {
        throw new TypeError("Tool origin has unsupported fields");
    }
    const namedAPath = requireBoolean(requireOwnDataField(origin, "namedAPath"), "namedAPath");
    const pathField = ownDataField(origin, "path");
    const cwdField = ownDataField(origin, "cwd");
    const pinnedField = ownDataField(context, "pinnedRepositoryKeys");
    const toolOrigin = privacyMode === "metadata"
        ? { namedAPath }
        : {
            ...(pathField.present
                ? { path: requireNonBlankString(pathField.value, "Tool path") }
                : {}),
            ...(cwdField.present ? { cwd: requireNonBlankString(cwdField.value, "Tool cwd") } : {}),
            namedAPath,
        };
    let pinnedRepositoryKeys;
    if (privacyMode === "full" && pinnedField.present) {
        pinnedRepositoryKeys = requireStringArray(pinnedField.value, "Pinned repository keys");
        if (pinnedRepositoryKeys.some((key) => key.trim().length === 0))
            throw new TypeError("Pinned repository keys must be nonblank");
        if (new Set(pinnedRepositoryKeys).size !== pinnedRepositoryKeys.length)
            throw new TypeError("Pinned repository keys must be unique");
    }
    return {
        toolOrigin,
        ...(pinnedRepositoryKeys === undefined ? {} : { pinnedRepositoryKeys }),
    };
}
function validateTurnEvidence(value) {
    const evidence = requirePlainRecord(value, "Turn evidence");
    canonicalJson(evidence);
    const keys = Object.keys(evidence).toSorted();
    if (RECONSTRUCTION_TURN_EVIDENCE_KEYS.some((key) => !keys.includes(key)) ||
        keys.some((key) => !RECONSTRUCTION_TURN_EVIDENCE_KEYS_WITH_ROOT.includes(key)))
        throw new TypeError("Reconstruction turn evidence must be structural only");
    const childRunIds = requireStringArray(requireOwnDataField(evidence, "childRunIds"), "Child run IDs");
    for (const childRunId of childRunIds) {
        requireNonBlankString(childRunId, "Child run ID");
        validateIdentifier(childRunId, "child run ID");
    }
    const rootRunIdField = ownDataField(evidence, "rootRunId");
    const rootRunId = rootRunIdField.present
        ? requireNonBlankString(rootRunIdField.value, "Root run ID")
        : undefined;
    if (rootRunId !== undefined)
        validateIdentifier(rootRunId, "root run ID");
    const closureState = requireOwnDataField(evidence, "closureState");
    if (typeof closureState !== "string" ||
        !RECONSTRUCTION_CLOSURE_STATES.includes(closureState)) {
        throw new TypeError("Reconstruction turn evidence has an invalid closure state");
    }
    return {
        ...(rootRunId === undefined ? {} : { rootRunId }),
        childRunIds,
        closureState: closureState,
    };
}
function jobRecord(job) {
    const scope = scopeOf(job);
    return {
        ...scope,
        runId: `${RECONSTRUCTION_RUN_ID_PREFIX}${identifierHash(canonicalJson(scope))}`,
        destinationFingerprint: job.accountFingerprint,
        eventKind: RECONSTRUCTION_JOB_KIND,
        normalizedPayload: canonicalValue({
            recordVersion: RECONSTRUCTION_RECORD_VERSION,
            privacyMode: job.privacyMode,
            sourceRefs: [...job.sourceRefs],
            ...(job.sourceAgeStartedAtMs === undefined
                ? {}
                : { sourceAgeStartedAtMs: job.sourceAgeStartedAtMs }),
            ...(job.sourceSnapshots === undefined
                ? {}
                : {
                    sourceSnapshots: job.sourceSnapshots.map((snapshot) => ({
                        sourceRef: snapshot.sourceRef,
                        submission: snapshot.submission,
                        sourceAgeStartedAtMs: snapshot.sourceAgeStartedAtMs,
                        ...(snapshot.attributionContext === undefined
                            ? {}
                            : { attributionContext: snapshot.attributionContext }),
                    })),
                }),
        }, new Set()),
        turnEvidence: canonicalValue(job.turnEvidence, new Set()),
        metadataProvenance: {},
    };
}
function mappingRecord(job, outputs) {
    const scope = mappingScope(job);
    return {
        ...scope,
        runId: scope.eventId,
        destinationFingerprint: job.accountFingerprint,
        eventKind: RECONSTRUCTION_MAPPING_KIND,
        normalizedPayload: {
            recordVersion: RECONSTRUCTION_RECORD_VERSION,
            jobEventId: job.eventId,
            outputs: outputs.map(({ eventId, runId, dependencies, sourceRef }) => ({
                eventId,
                runId,
                ...(sourceRef === undefined ? {} : { sourceRef }),
                ...(dependencies === undefined
                    ? {}
                    : {
                        dependencies: dependencies.map((dependency) => ({
                            integration: dependency.integration,
                            sessionId: dependency.sessionId,
                            turnId: dependency.turnId,
                            eventId: dependency.eventId,
                        })),
                    }),
            })),
        },
        turnEvidence: canonicalValue(job.turnEvidence, new Set()),
        metadataProvenance: {},
    };
}
function readJob(record, integration) {
    if (record.integration !== integration || record.eventKind !== RECONSTRUCTION_JOB_KIND)
        throw new Error("Stored reconstruction job namespace does not match");
    const payload = requirePlainRecord(record.normalizedPayload, "Stored reconstruction job");
    if (payload["recordVersion"] !== RECONSTRUCTION_RECORD_VERSION)
        throw new Error("Unsupported reconstruction job");
    const payloadKeys = Object.keys(payload).toSorted();
    if (RECONSTRUCTION_STORED_JOB_KEYS.some((key) => !payloadKeys.includes(key)) ||
        payloadKeys.some((key) => !RECONSTRUCTION_STORED_JOB_KEYS.includes(key) &&
            !RECONSTRUCTION_STORED_JOB_OPTIONAL_KEYS.includes(key)))
        throw new Error("Stored reconstruction job has unsupported fields");
    const privacyMode = payload["privacyMode"];
    if (privacyMode !== "full" && privacyMode !== "metadata")
        throw new Error("Invalid stored reconstruction privacy mode");
    const sourceRefs = requireStringArray(payload["sourceRefs"], "Stored source refs");
    if (sourceRefs.length === 0)
        throw new Error("Stored reconstruction source refs are empty");
    if (new Set(sourceRefs).size !== sourceRefs.length)
        throw new Error("Stored reconstruction source refs are not unique");
    for (const ref of sourceRefs) {
        requireNonBlankString(ref, "Stored source ref");
        validateIdentifier(ref, "source ref");
    }
    const sourceSnapshotsField = ownDataField(payload, "sourceSnapshots");
    const sourceAgeField = ownDataField(payload, "sourceAgeStartedAtMs");
    if (sourceSnapshotsField.present && sourceAgeField.present)
        throw new Error("Stored reconstruction job combines snapshots with a job-level source age");
    const sourceAgeStartedAtMs = sourceAgeField.present
        ? requireSafeEpochMilliseconds(sourceAgeField.value, "Stored source age")
        : undefined;
    const sourceSnapshots = sourceSnapshotsField.present
        ? validateSourceSnapshots(sourceSnapshotsField.value, integration, privacyMode, sourceRefs)
        : undefined;
    const turnEvidence = validateTurnEvidence(record.turnEvidence);
    if (Object.keys(requirePlainRecord(record.metadataProvenance, "Stored metadata provenance"))
        .length > 0)
        throw new Error("Reconstruction jobs cannot store metadata provenance");
    if (record.dependencies !== undefined)
        throw new Error("Reconstruction jobs cannot have capture dependencies");
    return {
        integration,
        sessionId: record.sessionId,
        turnId: record.turnId,
        eventId: record.eventId,
        accountFingerprint: record.destinationFingerprint,
        sourceRefs,
        privacyMode,
        turnEvidence,
        ...(sourceSnapshots === undefined ? {} : { sourceSnapshots }),
        ...(sourceAgeStartedAtMs === undefined ? {} : { sourceAgeStartedAtMs }),
    };
}
function readMapping(record) {
    if (record.eventKind !== RECONSTRUCTION_MAPPING_KIND)
        throw new Error("Unsupported reconstruction mapping");
    const payload = requirePlainRecord(record.normalizedPayload, "Stored reconstruction mapping");
    if (payload["recordVersion"] !== RECONSTRUCTION_RECORD_VERSION)
        throw new Error("Unsupported reconstruction mapping");
    const jobEventId = requireNonBlankString(payload["jobEventId"], "Job event ID");
    const outputs = payload["outputs"];
    if (!Array.isArray(outputs) || outputs.length === 0)
        throw new Error("Stored reconstruction mapping has no outputs");
    const seen = new Set();
    const normalizedOutputs = outputs.map((value) => {
        const output = requirePlainRecord(value, "Stored reconstruction output");
        const eventId = requireNonBlankString(output["eventId"], "Output event ID");
        const runId = requireNonBlankString(output["runId"], "Output run ID");
        validateIdentifier(eventId, "output event ID");
        validateIdentifier(runId, "output run ID");
        if (seen.has(eventId))
            throw new Error("Stored reconstruction event IDs are not unique");
        seen.add(eventId);
        const dependenciesField = ownDataField(output, "dependencies");
        const sourceRefField = ownDataField(output, "sourceRef");
        let sourceRef;
        if (sourceRefField.present) {
            sourceRef = requireNonBlankString(sourceRefField.value, "Output source ref");
            validateIdentifier(sourceRef, "output source ref");
        }
        let dependencies;
        if (dependenciesField.present) {
            if (!Array.isArray(dependenciesField.value))
                throw new Error("Stored reconstruction dependencies are invalid");
            dependencies = dependenciesField.value;
        }
        return {
            eventId,
            runId,
            ...(sourceRef === undefined ? {} : { sourceRef }),
            ...(dependencies === undefined ? {} : { dependencies }),
        };
    });
    return { recordVersion: RECONSTRUCTION_RECORD_VERSION, jobEventId, outputs: normalizedOutputs };
}
function sameOutputMapping(mapping, outputs) {
    return (canonicalJson(mapping.outputs) ===
        canonicalJson(outputs.map(({ eventId, runId, dependencies, sourceRef }) => ({
            eventId,
            runId,
            ...(sourceRef === undefined ? {} : { sourceRef }),
            ...(dependencies === undefined ? {} : { dependencies }),
        }))));
}
function scopeOf(value) {
    return {
        integration: value.integration,
        sessionId: value.sessionId,
        turnId: value.turnId,
        eventId: value.eventId,
    };
}
function mappingScope(job) {
    const eventId = `${RECONSTRUCTION_MAPPING_EVENT_ID_PREFIX}${identifierHash(canonicalJson(scopeOf(job)))}`;
    return { ...scopeOf(job), eventId };
}
//# sourceMappingURL=worker.js.map