import { CAPTURE_WAKE_ERROR_NAME, CAPTURE_WAKE_FAILURE_MESSAGE } from "./capture-wake-constants.js";
import { captureContentDigest } from "../storage/capture/compaction.js";
import type { SavedCaptureResult, SavedCaptureWakeOptions } from "./capture-wake-models.js";

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

export async function readSavedCaptureWake(
  error: unknown,
  options: SavedCaptureWakeOptions,
): Promise<SavedCaptureResult | undefined> {
  if (!(error instanceof CaptureWakeError)) return undefined;
  const result = structuredClone(error.captureResult);
  const { record } = result;
  if (
    record.integration !== options.integration ||
    record.sessionId !== options.sessionId ||
    record.turnId !== options.turnId ||
    record.destinationFingerprint !== options.destinationFingerprint ||
    (options.eventId !== undefined && record.eventId !== options.eventId) ||
    (options.runId !== undefined && record.runId !== options.runId)
  )
    return undefined;
  const saved = await options.store.read({
    integration: record.integration,
    sessionId: record.sessionId,
    turnId: record.turnId,
    eventId: record.eventId,
  });
  return saved !== undefined && captureContentDigest(saved) === captureContentDigest(record)
    ? { ...result, record: saved }
    : undefined;
}
