import { join } from "node:path";
import { withFileLock } from "../../storage/index.js";
import { identifierHash, validateIdentifier } from "../../storage/capture/paths.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import { canonicalJsonValue, ownDataField, requireNonBlankString, requireOwnDataField, requirePlainRecord, requireStringArray, } from "../../utils/validation/objects.js";
import { snapshotData } from "../../utils/validation/snapshot.js";
import { UPLOAD_PATCH_FIELDS } from "../upload/constants.js";
import { normalizedRedactedFields } from "../upload/redaction.js";
import { LIFECYCLE_SNAPSHOT_OPTIONAL_RUN_FIELDS, LIFECYCLE_PATCH_EVENT_KIND, LIFECYCLE_POST_EVENT_KIND, LIFECYCLE_SETTLEMENT_EVENT_KIND, LIFECYCLE_SNAPSHOT_LOCK_DIRECTORY, LIFECYCLE_SNAPSHOT_LOCK_FILE, LIFECYCLE_SNAPSHOT_REVISION_EVENT_ID_PREFIX, } from "./constants.js";
import { deriveAttributionReadiness } from "./closure.js";
import { projectSubmission, projectTurnEvidence } from "./projection.js";
import { SETTLEMENT_EVENT_ID_PATTERN } from "../settlement/constants.js";
import { wakeCapturedWork } from "../capture-wake.js";
export async function captureLifecycleSnapshot(options, input) {
    const captureInput = snapshotData(requirePlainRecord(input, "Lifecycle snapshot capture"));
    const snapshot = requirePlainRecord(captureInput, "Lifecycle snapshot capture");
    const turnId = requireNonBlankString(snapshot["turnId"], "Turn ID");
    const eventId = requireNonBlankString(snapshot["eventId"], "Event ID");
    validateIdentifier(turnId, "turn ID");
    validateIdentifier(eventId, "event ID");
    const submission = requirePlainRecord(snapshot["submission"], "Prepared run snapshot");
    if (submission["operation"] !== "post")
        throw new TypeError("A full run snapshot must be a POST");
    const sourceRun = requirePlainRecord(requireOwnDataField(submission, "run"), "Run snapshot");
    const runId = requireNonBlankString(requireOwnDataField(sourceRun, "id"), "Run ID");
    validateIdentifier(runId, "run ID");
    const streamHash = identifierHash(`${options.integration}\0${options.sessionId}\0${turnId}\0${runId}`);
    const revisionPrefix = `${LIFECYCLE_SNAPSHOT_REVISION_EVENT_ID_PREFIX}${streamHash}:`;
    const lockDirectory = await ensurePrivateDirectory(options.storageRoot, [
        LIFECYCLE_SNAPSHOT_LOCK_DIRECTORY,
        "integrations",
        options.integration,
        "sessions",
        identifierHash(options.sessionId),
        "turns",
        identifierHash(turnId),
        "runs",
        identifierHash(runId),
    ]);
    return withFileLock(join(lockDirectory, LIFECYCLE_SNAPSHOT_LOCK_FILE), async () => {
        const records = (await options.store.enumerateTurn(options.integration, options.sessionId, turnId))
            .map(({ record }) => record)
            .filter((record) => record.runId === runId);
        const state = readSnapshotState(records, options.destinationFingerprint, revisionPrefix);
        if (state === "conflict")
            return { status: "conflict" };
        if (state === undefined) {
            if (records.length > 0)
                return { status: "conflict" };
            return options.capture(captureInput);
        }
        if (state.post.destinationFingerprint !== options.destinationFingerprint) {
            return { status: "conflict" };
        }
        const projected = projectSubmission(snapshot["submission"], options.integration, runContext(state.post));
        if (projected.status === "deferred") {
            return { status: "deferred", reason: "missing-thread-identity" };
        }
        if (projected.value.payload.operation !== "post")
            return { status: "conflict" };
        if (projected.value.payload.privacyMode !== state.privacyMode ||
            !sameCanonical(normalizedRedactedFields(projected.value.payload.redactedFields), state.redactedFields)) {
            return { status: "conflict" };
        }
        const candidateRun = applySnapshotOmissions(projected.value.payload.run, state.run, sourceRun);
        if (!sameRunIdentity(state.run, candidateRun))
            return { status: "conflict" };
        const privacyStatus = state.privacyMode === "metadata"
            ? projected.value.privacyStatus
            : runPrivacyStatus(candidateRun);
        const evidence = projectTurnEvidence(snapshot["turnEvidence"], state.privacyMode, deriveAttributionReadiness(snapshot["submission"], options.integration));
        const metadata = canonicalJsonValue(projected.value.metadata);
        const changedFields = snapshotPatchFields(state.run, candidateRun);
        const newDependencies = (captureInput.dependencies ?? []).some((dependency) => !sameCanonical(dependency, captureScope(state.head)) &&
            !state.snapshotDependencies.some((persisted) => sameCanonical(dependency, persisted)));
        if (changedFields.length === 0 &&
            sameCanonical(state.metadataProvenance, metadata) &&
            sameCanonical(state.turnEvidence, evidence) &&
            state.privacyStatus === privacyStatus &&
            !newDependencies) {
            const result = { status: "duplicate", record: state.head };
            await wakeCapturedWork(result, options.wake);
            return result;
        }
        const patchValues = {};
        for (const field of changedFields) {
            const value = ownDataField(sourceRun, field);
            if (!value.present || value.value === undefined)
                return { status: "conflict" };
            patchValues[field] = value.value;
        }
        const patch = {
            operation: "patch",
            integration: options.integration,
            privacyMode: state.privacyMode,
            ...(submission["redactedFields"] === undefined
                ? {}
                : { redactedFields: normalizedRedactedFields(submission["redactedFields"]) }),
            metadata: captureInput.submission.metadata,
            run: runContext(state.post),
            privacyContext: { status: privacyStatus },
            patch: { fields: changedFields, values: patchValues },
        };
        const nextRevision = state.revisionCount + 1;
        const revisionInput = {
            turnId,
            eventId: `${revisionPrefix}${String(nextRevision).padStart(12, "0")}`,
            submission: patch,
            turnEvidence: captureInput.turnEvidence,
            dependencies: [
                captureScope(state.head),
                ...(captureInput.dependencies ?? []).filter((dependency) => !sameCanonical(dependency, captureScope(state.head))),
            ],
            sourceAgeStartedAtMs: state.post.sourceAgeStartedAtMs ?? state.post.capturedAtMs,
        };
        return options.capture(revisionInput);
    });
}
function readSnapshotState(records, destinationFingerprint, revisionPrefix) {
    const posts = records.filter((record) => record.eventKind === LIFECYCLE_POST_EVENT_KIND);
    const revisionCandidates = records.filter((record) => record.eventId.startsWith(revisionPrefix));
    if (posts.length > 1)
        return "conflict";
    const post = posts[0];
    if (post === undefined)
        return records.length === 0 ? undefined : "conflict";
    if (post.destinationFingerprint !== destinationFingerprint || recordOperation(post) !== "post") {
        return "conflict";
    }
    const postPayload = payloadObject(post);
    const privacyMode = readPrivacyMode(postPayload);
    const run = storedRun(postPayload, post.runId);
    const redactedFields = storedRedactedFields(postPayload);
    let metadataProvenance = canonicalJsonValue(post.metadataProvenance);
    let turnEvidence = canonicalJsonValue(post.turnEvidence);
    let privacyStatus = storedPrivacyStatus(postPayload, run, privacyMode);
    const runFields = run;
    let head = post;
    const orderedRevisions = revisionCandidates.toSorted((left, right) => left.eventId.localeCompare(right.eventId));
    let expectedPrevious = post;
    for (let index = 0; index < orderedRevisions.length; index += 1) {
        const revision = orderedRevisions[index];
        const expectedId = `${revisionPrefix}${String(index + 1).padStart(12, "0")}`;
        if (revision.eventId !== expectedId ||
            revision.eventKind !== LIFECYCLE_PATCH_EVENT_KIND ||
            revision.destinationFingerprint !== destinationFingerprint ||
            !sameDependencies(revision, expectedPrevious)) {
            return "conflict";
        }
        const payload = payloadObject(revision);
        if (readPrivacyMode(payload) !== privacyMode)
            return "conflict";
        const candidateFields = storedRedactedFields(payload);
        if (!sameCanonical(candidateFields, redactedFields))
            return "conflict";
        const patch = requirePlainRecord(requireOwnDataField(payload, "patch"), "Stored run patch");
        const values = requirePlainRecord(requireOwnDataField(patch, "values"), "Stored patch values");
        const fields = requireStringArray(requireOwnDataField(patch, "fields"), "Stored patch fields");
        const seen = new Set();
        for (const field of fields) {
            if (!UPLOAD_PATCH_FIELDS.has(field) || seen.has(field))
                return "conflict";
            const value = ownDataField(values, field);
            if (!value.present || value.value === undefined)
                return "conflict";
            runFields[field] = value.value;
            seen.add(field);
        }
        const runContextValue = requirePlainRecord(requireOwnDataField(payload, "run"), "Stored run context");
        if (!sameRunIdentity(run, runContextValue))
            return "conflict";
        privacyStatus = readPrivacyStatus(requireOwnDataField(payload, "privacyContext"));
        metadataProvenance = canonicalJsonValue(revision.metadataProvenance);
        turnEvidence = canonicalJsonValue(revision.turnEvidence);
        head = revision;
        expectedPrevious = revision;
    }
    const snapshotChain = [post, ...orderedRevisions];
    for (const record of records) {
        if (snapshotChain.includes(record))
            continue;
        if (record.eventKind !== LIFECYCLE_SETTLEMENT_EVENT_KIND ||
            !SETTLEMENT_EVENT_ID_PATTERN.test(record.eventId) ||
            record.destinationFingerprint !== destinationFingerprint ||
            !validSettlementRecord(record, run, privacyMode, redactedFields, snapshotChain)) {
            return "conflict";
        }
    }
    return {
        post,
        head,
        run,
        metadataProvenance,
        turnEvidence,
        privacyMode,
        redactedFields,
        privacyStatus,
        revisionCount: orderedRevisions.length,
        snapshotDependencies: snapshotChain.flatMap((record) => record.dependencies ?? []),
    };
}
function payloadObject(record) {
    return requirePlainRecord(record.normalizedPayload, "Stored run payload");
}
function recordOperation(record) {
    return payloadObject(record)["operation"];
}
function validSettlementRecord(record, currentRun, privacyMode, redactedFields, snapshotChain) {
    const payload = payloadObject(record);
    if (recordOperation(record) !== "patch" || readPrivacyMode(payload) !== privacyMode)
        return false;
    if (!sameCanonical(storedRedactedFields(payload), redactedFields))
        return false;
    readPrivacyStatus(requireOwnDataField(payload, "privacyContext"));
    const run = requirePlainRecord(requireOwnDataField(payload, "run"), "Settlement run context");
    if (!sameRunIdentity(currentRun, run))
        return false;
    const patch = requirePlainRecord(requireOwnDataField(payload, "patch"), "Settlement run patch");
    const fields = requireStringArray(requireOwnDataField(patch, "fields"), "Settlement patch fields");
    const values = requirePlainRecord(requireOwnDataField(patch, "values"), "Settlement patch values");
    const seen = new Set();
    for (const field of fields) {
        if (!UPLOAD_PATCH_FIELDS.has(field) || seen.has(field))
            return false;
        const value = ownDataField(values, field);
        if (!value.present || value.value === undefined)
            return false;
        seen.add(field);
    }
    return (record.dependencies ?? []).some((dependency) => snapshotChain.some((source) => sameCanonical(dependency, captureScope(source))));
}
function readPrivacyMode(payload) {
    const value = requireOwnDataField(payload, "privacyMode");
    if (value !== "full" && value !== "metadata")
        throw new TypeError("Stored privacy mode is invalid");
    return value;
}
function storedRun(payload, runId) {
    const run = canonicalJsonValue(requireOwnDataField(payload, "run"));
    const source = requirePlainRecord(run, "Stored run snapshot");
    if (source["id"] !== runId)
        throw new TypeError("Stored run ID does not match its capture");
    requireNonBlankString(source["name"], "Run name");
    requireNonBlankString(source["run_type"], "Run type");
    return source;
}
function storedRedactedFields(payload) {
    const field = ownDataField(payload, "redactedFields");
    return normalizedRedactedFields(field.present ? field.value : undefined);
}
function storedPrivacyStatus(payload, run, privacyMode) {
    if (privacyMode === "metadata")
        return readPrivacyStatus(requireOwnDataField(payload, "privacyContext"));
    return runPrivacyStatus(run);
}
function readPrivacyStatus(value) {
    const context = requirePlainRecord(value, "Run privacy context");
    const status = requireOwnDataField(context, "status");
    if (status !== "running" && status !== "completed" && status !== "error") {
        throw new TypeError("Invalid run privacy status");
    }
    return status;
}
function runPrivacyStatus(run) {
    if (run.error !== undefined)
        return "error";
    if (run.end_time !== undefined)
        return "completed";
    return "running";
}
function applySnapshotOmissions(current, previous, sourceRun) {
    const result = { ...current };
    const resultFields = result;
    const previousFields = previous;
    for (const field of LIFECYCLE_SNAPSHOT_OPTIONAL_RUN_FIELDS) {
        const supplied = ownDataField(sourceRun, field);
        if (supplied.present && supplied.value !== undefined)
            continue;
        const oldValue = ownDataField(previousFields, field);
        if (oldValue.present)
            resultFields[field] = oldValue.value;
        else
            delete resultFields[field];
    }
    return result;
}
function snapshotPatchFields(previous, current) {
    const previousFields = previous;
    const currentFields = current;
    return [...UPLOAD_PATCH_FIELDS].filter((field) => {
        const oldValue = ownDataField(previousFields, field);
        const nextValue = ownDataField(currentFields, field);
        if (oldValue.present !== nextValue.present)
            return true;
        return oldValue.present && nextValue.present && !sameCanonical(oldValue.value, nextValue.value);
    });
}
function sameRunIdentity(left, right) {
    return (left.id === right.id &&
        left.name === right.name &&
        left.run_type === right.run_type &&
        sameTimestamp(left.start_time, right.start_time) &&
        left.parent_run_id === right.parent_run_id &&
        left.trace_id === right.trace_id &&
        left.dotted_order === right.dotted_order);
}
function sameTimestamp(left, right) {
    if (left === undefined || right === undefined)
        return left === right;
    return new Date(left).getTime() === new Date(right).getTime();
}
function runContext(record) {
    const run = storedRun(payloadObject(record), record.runId);
    return {
        id: run.id,
        name: run.name,
        run_type: run.run_type,
        ...(run.start_time === undefined ? {} : { start_time: run.start_time }),
        ...(run.parent_run_id === undefined ? {} : { parent_run_id: run.parent_run_id }),
        ...(run.trace_id === undefined ? {} : { trace_id: run.trace_id }),
        ...(run.dotted_order === undefined ? {} : { dotted_order: run.dotted_order }),
    };
}
function sameDependencies(record, previous) {
    const dependencies = record.dependencies ?? [];
    return dependencies.some((dependency) => sameCanonical(dependency, captureScope(previous)));
}
function captureScope(record) {
    return {
        integration: record.integration,
        sessionId: record.sessionId,
        turnId: record.turnId,
        eventId: record.eventId,
    };
}
function sameCanonical(left, right) {
    return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}
//# sourceMappingURL=snapshot.js.map