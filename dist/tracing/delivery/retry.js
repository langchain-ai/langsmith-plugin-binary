import { DELIVERY_AUTH_HINT, DELIVERY_AUTH_STATUSES, DELIVERY_REJECTED_REASON, DELIVERY_RETRY_BACKOFF_FACTOR, DELIVERY_RETRY_MAX_MS, } from "./constants.js";
import { failureStatus } from "../../utils/errors.js";
export function isRetryable(error) {
    return error?.retryable !== false;
}
export function rejection(error) {
    const status = failureStatus(error);
    return status === undefined
        ? { reason: DELIVERY_REJECTED_REASON }
        : { reason: `${DELIVERY_REJECTED_REASON} (HTTP ${status})`, status };
}
export function authHint(status) {
    return status !== undefined && DELIVERY_AUTH_STATUSES.includes(status)
        ? ` ${DELIVERY_AUTH_HINT}`
        : "";
}
export function nextRetry(previous, baseMs) {
    const failures = (previous?.failures ?? 0) + 1;
    return {
        failures,
        recordedAtMs: Date.now(),
        notBeforeMs: Date.now() +
            Math.min(baseMs * DELIVERY_RETRY_BACKOFF_FACTOR ** (failures - 1), DELIVERY_RETRY_MAX_MS),
    };
}
//# sourceMappingURL=retry.js.map