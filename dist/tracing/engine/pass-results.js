export function reconstructionPassResult(result) {
    if (result.status === "busy")
        return "retryable-failure";
    if (waitingOnBackoff(result))
        return "deferred";
    return result.captured > 0 || result.dropped > 0 ? "progressed" : "idle";
}
export function lifecyclePassResult(result) {
    if (result.status === "busy")
        return "retryable-failure";
    if (waitingOnBackoff(result))
        return "deferred";
    return result.settlement.captured > 0 || result.delivered > 0 || result.dropped > 0
        ? "progressed"
        : "idle";
}
function waitingOnBackoff(result) {
    return result.pending > 0 && result.nextRetryAtMs !== undefined;
}
//# sourceMappingURL=pass-results.js.map