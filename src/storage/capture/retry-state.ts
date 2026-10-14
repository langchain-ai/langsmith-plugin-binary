import type { CaptureRetry } from "./models.js";

const PROCESS_STARTED_AT_MS = Date.now();

export function isWaitingForRetry(retry: CaptureRetry | undefined, now = Date.now()): boolean {
  return (
    retry !== undefined &&
    retry.notBeforeMs > now &&
    !(retry.recordedAtMs !== undefined && retry.recordedAtMs < PROCESS_STARTED_AT_MS)
  );
}
