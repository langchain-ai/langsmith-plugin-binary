import { CAPTURE_WAKE_ERROR_NAME, CAPTURE_WAKE_FAILURE_MESSAGE } from "./capture-wake-constants.js";
import type { SavedCaptureResult } from "./capture-wake-models.js";

export class CaptureWakeError extends Error {
  readonly captureResult: SavedCaptureResult;

  constructor(captureResult: SavedCaptureResult, cause: unknown) {
    super(
      `${CAPTURE_WAKE_FAILURE_MESSAGE}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = CAPTURE_WAKE_ERROR_NAME;
    this.captureResult = captureResult;
  }
}

export async function wakeCapturedWork(
  captureResult: SavedCaptureResult,
  wake: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    await wake();
  } catch (cause) {
    throw new CaptureWakeError(captureResult, cause);
  }
}
