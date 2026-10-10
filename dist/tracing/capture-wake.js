import { CAPTURE_WAKE_ERROR_NAME, CAPTURE_WAKE_FAILURE_MESSAGE } from "./capture-wake-constants.js";
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
    const { record } = error.captureResult;
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
    return saved !== undefined && canonicalJson(saved) === canonicalJson(record)
        ? error.captureResult
        : undefined;
}
//# sourceMappingURL=capture-wake.js.map