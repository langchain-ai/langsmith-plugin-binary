import { join, resolve } from "node:path";
import { withFileLock } from "../index.js";
import { CAPTURE_COMPACTED_RECORD_VERSION, CAPTURE_DIRECTORY, CAPTURE_HASH, CAPTURE_RECORD_LOCK_DIRECTORY, CAPTURE_RECORD_VERSION, CAPTURE_RECONSTRUCTION_JOB_KIND, CAPTURE_RECEIPT_VERSION, } from "./constants.js";
import { eventPath, identifierHash, receiptPath, validateIdentifier, validateIntegration, } from "./paths.js";
import { ensurePrivateDirectory, publishExclusive, readPrivateFile, replacePrivateFile, } from "./utils/atomic-file.js";
import { captureContentDigest, compactCaptureRecord, compactReconstructionJobRecord, validateCompactionMarker, validateSourceSnapshotCleanup, } from "./compaction.js";
import { canonicalJson, canonicalValue } from "./utils/serialization.js";
export function createCaptureStore(root) {
    const storageRoot = resolve(root);
    return {
        async capture(input) {
            let record;
            let contents;
            try {
                validateScope(input);
                validateIdentifier(input.runId, "run ID");
                validateIdentifier(input.destinationFingerprint, "destination fingerprint");
                validateIdentifier(input.eventKind, "event kind");
                record = {
                    version: CAPTURE_RECORD_VERSION,
                    capturedAtMs: Date.now(),
                    integration: input.integration,
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    eventId: input.eventId,
                    runId: input.runId,
                    destinationFingerprint: input.destinationFingerprint,
                    eventKind: input.eventKind,
                    normalizedPayload: canonicalValue(input.normalizedPayload, new Set()),
                    turnEvidence: canonicalValue(input.turnEvidence, new Set()),
                    metadataProvenance: canonicalValue(input.metadataProvenance, new Set()),
                };
                contents = canonicalJson(record);
            }
            catch (error) {
                return failure("SERIALIZATION_FAILED", error);
            }
            try {
                const path = eventPath(storageRoot, input);
                return await withRecordLock(storageRoot, input, async () => {
                    await ensureDirectories(input.integration, input.sessionId, input.turnId, "events");
                    if (await publishExclusive(path, contents))
                        return { status: "published", record };
                    const previous = await readRecord(storageRoot, path);
                    if (previous === undefined)
                        return {
                            status: "failed",
                            code: "STORAGE_FAILED",
                            message: "Published event disappeared",
                        };
                    if (!sameScope(previous, input))
                        return { status: "conflict" };
                    return sameCapture(previous, record)
                        ? { status: "duplicate", record: previous }
                        : { status: "conflict" };
                });
            }
            catch (error) {
                return failure("STORAGE_FAILED", error);
            }
        },
        async read(scope) {
            validateScope(scope);
            const record = await readRecord(storageRoot, eventPath(storageRoot, scope));
            if (record === undefined)
                return undefined;
            if (!sameScope(record, scope))
                throw new Error("Capture namespace does not match");
            return record;
        },
        async compact(scope, expected) {
            try {
                validateScope(scope);
                if (!sameScope(expected, scope))
                    throw new TypeError("Capture namespace does not match");
                const expectedOriginalContentDigest = expected.compaction?.originalContentDigest ?? captureContentDigest(expected);
                if (!CAPTURE_HASH.test(expectedOriginalContentDigest))
                    throw new TypeError("Invalid original capture digest");
                return await withRecordLock(storageRoot, scope, async () => {
                    const path = eventPath(storageRoot, scope);
                    const previous = await readRecord(storageRoot, path);
                    if (previous === undefined)
                        return { status: "missing-capture" };
                    const originalContentDigest = previous.compaction?.originalContentDigest ?? captureContentDigest(previous);
                    if (originalContentDigest !== expectedOriginalContentDigest)
                        return { status: "changed" };
                    if (previous.compaction !== undefined)
                        return { status: "already-compacted", record: previous };
                    const record = compactCaptureRecord(previous, originalContentDigest);
                    if (record === undefined)
                        return { status: "changed" };
                    await replacePrivateFile(storageRoot, path, canonicalJson(record));
                    return { status: "compacted", record };
                });
            }
            catch (error) {
                return failure("STORAGE_FAILED", error);
            }
        },
        async compactReconstructionJob(scope, expected, destination) {
            try {
                validateScope(scope);
                validateIdentifier(destination, "destination");
                if (!sameScope(expected, scope) || expected.eventKind !== CAPTURE_RECONSTRUCTION_JOB_KIND)
                    throw new TypeError("Capture is not the expected reconstruction job");
                if (destination !== expected.destinationFingerprint)
                    throw new TypeError("Reconstruction job destination does not match");
                const expectedOriginalContentDigest = captureContentDigest(expected);
                if (!CAPTURE_HASH.test(expectedOriginalContentDigest))
                    throw new TypeError("Invalid original reconstruction job digest");
                return await withRecordLock(storageRoot, scope, async () => {
                    const path = eventPath(storageRoot, scope);
                    const previous = await readRecord(storageRoot, path);
                    if (previous === undefined)
                        return { status: "missing-capture" };
                    if (!sameScope(previous, scope))
                        throw new Error("Capture namespace does not match");
                    if (captureContentDigest(previous) !== expectedOriginalContentDigest)
                        return { status: "changed" };
                    const payload = previous.normalizedPayload;
                    const hasSourceSnapshots = payload !== null &&
                        typeof payload === "object" &&
                        !Array.isArray(payload) &&
                        Object.hasOwn(payload, "sourceSnapshots");
                    if (!hasSourceSnapshots && previous.sourceSnapshotCleanup === undefined)
                        return { status: "unchanged" };
                    const receipt = await readReceipt(storageRoot, receiptPath(storageRoot, scope, destination));
                    if (receipt?.outcome !== "delivered" ||
                        receipt.destination !== destination ||
                        !sameScope(receipt, scope))
                        return { status: "not-delivered" };
                    if (previous.sourceSnapshotCleanup !== undefined)
                        return { status: "already-compacted", record: previous };
                    const compacted = compactReconstructionJobRecord(previous, expectedOriginalContentDigest);
                    if (compacted === undefined)
                        return { status: "changed" };
                    await replacePrivateFile(storageRoot, path, canonicalJson(compacted));
                    return { status: "compacted", record: compacted };
                });
            }
            catch (error) {
                return failure("STORAGE_FAILED", error);
            }
        },
        async recordOutcome(input) {
            try {
                validateScope(input);
                validateIdentifier(input.destination, "destination");
                if (input.outcome !== "delivered" && input.outcome !== "dropped")
                    throw new TypeError("Invalid outcome");
                if (input.reason !== undefined)
                    validateIdentifier(input.reason, "outcome reason");
                return await withRecordLock(storageRoot, input, async () => {
                    if ((await readRecord(storageRoot, eventPath(storageRoot, input))) === undefined)
                        return { status: "missing-capture" };
                    const path = receiptPath(storageRoot, input, input.destination);
                    await ensureDirectories(input.integration, input.sessionId, input.turnId, "receipts", input.destination);
                    const comparable = receiptValue(input, new Date().toISOString());
                    const contents = canonicalJson(comparable);
                    if (await publishExclusive(path, contents))
                        return { status: "recorded", receipt: comparable };
                    const previous = await readReceipt(storageRoot, path);
                    if (previous === undefined)
                        return {
                            status: "failed",
                            code: "STORAGE_FAILED",
                            message: "Published receipt disappeared",
                        };
                    return sameReceipt(previous, input)
                        ? { status: "duplicate", receipt: previous }
                        : { status: "conflict" };
                });
            }
            catch (error) {
                return failure("STORAGE_FAILED", error);
            }
        },
        async readOutcome(scope, destination) {
            try {
                validateScope(scope);
                validateIdentifier(destination, "destination");
                if ((await readRecord(storageRoot, eventPath(storageRoot, scope))) === undefined)
                    return { status: "missing-capture" };
                const receipt = await readReceipt(storageRoot, receiptPath(storageRoot, scope, destination));
                if (receipt === undefined)
                    return { status: "pending" };
                return sameScope(receipt, scope) && receipt.destination === destination
                    ? { status: "settled", receipt }
                    : {
                        status: "failed",
                        code: "STORAGE_FAILED",
                        message: "Receipt namespace does not match",
                    };
            }
            catch (error) {
                return failure("STORAGE_FAILED", error);
            }
        },
    };
    async function ensureDirectories(integration, sessionId, turnId, collection, destination) {
        const pathSegments = [
            CAPTURE_DIRECTORY,
            "integrations",
            integration,
            "sessions",
            identifierHash(sessionId),
            "turns",
            identifierHash(turnId),
            collection,
        ];
        if (destination !== undefined)
            pathSegments.push(identifierHash(destination));
        await ensurePrivateDirectory(storageRoot, pathSegments);
    }
}
async function withRecordLock(root, scope, operation) {
    validateScope(scope);
    return withRecordLockByHashes(root, scope.integration, identifierHash(scope.sessionId), identifierHash(scope.turnId), identifierHash(scope.eventId), operation);
}
async function withRecordLockByHashes(root, integration, sessionHash, turnHash, eventHash, operation) {
    if (![sessionHash, turnHash, eventHash].every((value) => CAPTURE_HASH.test(value)))
        throw new TypeError("Invalid capture record lock path");
    const directory = await ensurePrivateDirectory(root, [
        CAPTURE_RECORD_LOCK_DIRECTORY,
        "integrations",
        integration,
        "sessions",
        sessionHash,
        "turns",
        turnHash,
        "events",
    ]);
    return withFileLock(join(directory, `${eventHash}.lock`), operation);
}
function sameCapture(left, right) {
    const leftDigest = left.compaction?.originalContentDigest ?? captureContentDigest(left);
    return leftDigest === captureContentDigest(right);
}
function receiptValue(input, recordedAt) {
    return {
        version: CAPTURE_RECEIPT_VERSION,
        integration: input.integration,
        sessionId: input.sessionId,
        turnId: input.turnId,
        eventId: input.eventId,
        destination: input.destination,
        outcome: input.outcome,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        recordedAt,
    };
}
async function readRecord(root, path) {
    const contents = await readPrivateFile(root, path);
    if (contents === undefined)
        return undefined;
    const value = parseObject(contents);
    if ((value.version !== CAPTURE_RECORD_VERSION &&
        value.version !== CAPTURE_COMPACTED_RECORD_VERSION) ||
        typeof value.capturedAtMs !== "number" ||
        !Number.isSafeInteger(value.capturedAtMs) ||
        !Number.isFinite(new Date(value.capturedAtMs).getTime()) ||
        typeof value.integration !== "string" ||
        typeof value.sessionId !== "string" ||
        typeof value.turnId !== "string" ||
        typeof value.eventId !== "string" ||
        typeof value.runId !== "string" ||
        typeof value.destinationFingerprint !== "string" ||
        typeof value.eventKind !== "string" ||
        !("normalizedPayload" in value) ||
        !("turnEvidence" in value) ||
        !("metadataProvenance" in value)) {
        throw new Error("Unsupported capture record");
    }
    for (const [identifier, name] of [
        [value.runId, "run ID"],
        [value.destinationFingerprint, "destination fingerprint"],
        [value.eventKind, "event kind"],
    ]) {
        validateIdentifier(identifier, name);
    }
    const scope = {
        integration: value.integration,
        sessionId: value.sessionId,
        turnId: value.turnId,
        eventId: value.eventId,
    };
    validateScope(scope);
    const normalizedPayload = canonicalValue(value.normalizedPayload, new Set());
    const compaction = value.version === CAPTURE_COMPACTED_RECORD_VERSION
        ? validateCompactionMarker(value.compaction, value.eventKind, normalizedPayload)
        : undefined;
    if (value.version === CAPTURE_RECORD_VERSION && "compaction" in value)
        throw new Error("Invalid compacted capture marker");
    if (value.version === CAPTURE_COMPACTED_RECORD_VERSION && "sourceSnapshotCleanup" in value)
        throw new Error("Invalid reconstruction source snapshot cleanup marker");
    const sourceSnapshotCleanup = "sourceSnapshotCleanup" in value
        ? validateSourceSnapshotCleanup(value.sourceSnapshotCleanup, value.eventKind, normalizedPayload)
        : undefined;
    return {
        ...value,
        normalizedPayload,
        ...(compaction === undefined ? {} : { compaction }),
        ...(sourceSnapshotCleanup === undefined ? {} : { sourceSnapshotCleanup }),
    };
}
async function readReceipt(root, path) {
    const contents = await readPrivateFile(root, path);
    if (contents === undefined)
        return undefined;
    const value = parseObject(contents);
    if (value.version !== CAPTURE_RECEIPT_VERSION ||
        typeof value.integration !== "string" ||
        typeof value.sessionId !== "string" ||
        typeof value.turnId !== "string" ||
        typeof value.eventId !== "string" ||
        typeof value.destination !== "string" ||
        (value.outcome !== "delivered" && value.outcome !== "dropped") ||
        typeof value.recordedAt !== "string" ||
        ("reason" in value && typeof value.reason !== "string")) {
        throw new Error("Unsupported outcome receipt");
    }
    validateIdentifier(value.destination, "destination");
    if ("reason" in value)
        validateIdentifier(value.reason, "outcome reason");
    const recordedAt = new Date(value.recordedAt);
    if (!Number.isFinite(recordedAt.getTime()) || recordedAt.toISOString() !== value.recordedAt)
        throw new Error("Unsupported outcome receipt");
    return value;
}
function parseObject(contents) {
    const value = JSON.parse(contents);
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid storage record");
    return value;
}
function validateScope(scope) {
    validateIntegration(scope.integration);
    validateIdentifier(scope.sessionId, "session ID");
    validateIdentifier(scope.turnId, "turn ID");
    validateIdentifier(scope.eventId, "event ID");
}
function sameScope(record, scope) {
    return (record.integration === scope.integration &&
        record.sessionId === scope.sessionId &&
        record.turnId === scope.turnId &&
        record.eventId === scope.eventId);
}
function sameReceipt(receipt, input) {
    return (sameScope(receipt, input) &&
        receipt.destination === input.destination &&
        receipt.outcome === input.outcome &&
        receipt.reason === input.reason);
}
function failure(code, error) {
    return {
        status: "failed",
        code: errorCode(error) ?? code,
        message: error instanceof Error ? error.message : String(error),
    };
}
function errorCode(error) {
    return error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : undefined;
}
//# sourceMappingURL=capture-store.js.map