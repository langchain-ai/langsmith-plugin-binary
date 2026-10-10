import { CAPTURE_WAKE_ERROR_NAME, CAPTURE_WAKE_FAILURE_MESSAGE } from "./capture-wake-constants.js";
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
//# sourceMappingURL=capture-wake.js.map