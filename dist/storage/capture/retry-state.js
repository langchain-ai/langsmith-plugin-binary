const PROCESS_STARTED_AT_MS = Date.now();
export function isWaitingForRetry(retry, now = Date.now()) {
    return (retry !== undefined &&
        retry.notBeforeMs > now &&
        !(retry.recordedAtMs !== undefined && retry.recordedAtMs < PROCESS_STARTED_AT_MS));
}
//# sourceMappingURL=retry-state.js.map