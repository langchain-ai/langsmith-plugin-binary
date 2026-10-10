import type { SavedCaptureResult } from "./capture-wake-models.js";
export declare class CaptureWakeError extends Error {
    readonly captureResult: SavedCaptureResult;
    constructor(captureResult: SavedCaptureResult, cause: unknown);
}
export declare function wakeCapturedWork(captureResult: SavedCaptureResult, wake: () => unknown | Promise<unknown>): Promise<void>;
//# sourceMappingURL=capture-wake.d.ts.map