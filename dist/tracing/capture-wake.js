import { CAPTURE_WAKE_ERROR_NAME, CAPTURE_WAKE_FAILURE_MESSAGE } from "./capture-wake-constants.js";
import { CAPTURE_RECORD_VERSION } from "../storage/capture/constants.js";
import { captureContentDigest, compactCaptureRecord, compactReconstructionJobRecord, } from "../storage/capture/compaction.js";
import { canonicalJson } from "../storage/capture/utils/serialization.js";
export class CaptureWakeError extends Error {
    captureResult;
    constructor(captureResult, cause) {
        super(`${CAPTURE_WAKE_FAILURE_MESSAGE}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.name = CAPTURE_WAKE_ERROR_NAME;
        this.captureResult = captureResult;
    }
}
export async function wakeCapturedWork(captureResult, wake) {
    try {
        await wake();
    }
    catch (cause) {
        throw new CaptureWakeError(captureResult, cause);
    }
}
export async function readSavedCaptureWake(error, options) {
    if (!(error instanceof CaptureWakeError))
        return undefined;
    const result = structuredClone(error.captureResult);
    const { record } = result;
    if (record.integration !== options.integration ||
        record.sessionId !== options.sessionId ||
        record.turnId !== options.turnId ||
        record.destinationFingerprint !== options.destinationFingerprint ||
        (options.eventId !== undefined && record.eventId !== options.eventId) ||
        (options.runId !== undefined && record.runId !== options.runId))
        return undefined;
    const saved = await options.store.read({
        integration: record.integration,
        sessionId: record.sessionId,
        turnId: record.turnId,
        eventId: record.eventId,
    });
    return saved !== undefined && matchesPersistedCapture(saved, record)
        ? { ...result, record: saved }
        : undefined;
}
function matchesPersistedCapture(saved, reported) {
    if (canonicalJson(saved) === canonicalJson(reported))
        return true;
    if (reported.version !== CAPTURE_RECORD_VERSION ||
        reported.compaction !== undefined ||
        reported.sourceSnapshotCleanup !== undefined ||
        saved.capturedAtMs !== reported.capturedAtMs) {
        return false;
    }
    const originalContentDigest = captureContentDigest(reported);
    if (saved.compaction !== undefined &&
        saved.compaction.originalContentDigest === originalContentDigest) {
        const compacted = compactCaptureRecord(reported, originalContentDigest);
        return compacted !== undefined && canonicalJson(compacted) === canonicalJson(saved);
    }
    if (saved.sourceSnapshotCleanup !== undefined &&
        saved.sourceSnapshotCleanup.originalContentDigest === originalContentDigest) {
        const cleaned = compactReconstructionJobRecord(reported, originalContentDigest);
        return cleaned !== undefined && canonicalJson(cleaned) === canonicalJson(saved);
    }
    return false;
}
//# sourceMappingURL=capture-wake.js.map