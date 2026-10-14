import {
  DELIVERY_AUTH_HINT,
  DELIVERY_AUTH_STATUSES,
  DELIVERY_REJECTED_REASON,
  DELIVERY_RETRY_BACKOFF_FACTOR,
  DELIVERY_RETRY_MAX_MS,
} from "./constants.js";
import type { CaptureRetry } from "../../storage/capture/models.js";
import { failureStatus } from "../../utils/errors.js";
import type { DeliveryDroppedWork, DeliveryFailure } from "./models.js";

export function isRetryable(error: unknown): boolean {
  return (error as DeliveryFailure | undefined)?.retryable !== false;
}

export function rejection(error: unknown): DeliveryDroppedWork {
  const status = failureStatus(error);
  return status === undefined
    ? { reason: DELIVERY_REJECTED_REASON }
    : { reason: `${DELIVERY_REJECTED_REASON} (HTTP ${status})`, status };
}

export function authHint(status: number | undefined): string {
  return status !== undefined && DELIVERY_AUTH_STATUSES.includes(status)
    ? ` ${DELIVERY_AUTH_HINT}`
    : "";
}

export function nextRetry(previous: CaptureRetry | undefined, baseMs: number): CaptureRetry {
  const failures = (previous?.failures ?? 0) + 1;
  return {
    failures,
    recordedAtMs: Date.now(),
    notBeforeMs:
      Date.now() +
      Math.min(baseMs * DELIVERY_RETRY_BACKOFF_FACTOR ** (failures - 1), DELIVERY_RETRY_MAX_MS),
  };
}
