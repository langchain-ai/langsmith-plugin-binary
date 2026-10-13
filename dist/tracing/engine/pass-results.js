export function reconstructionPassResult(result) {
    if (result.status === "busy")
        return "retryable-failure";
    return result.captured > 0 || result.failed > 0 || result.dropped > 0 ? "progressed" : "idle";
}
export function lifecyclePassResult(result) {
    if (result.status === "busy")
        return "retryable-failure";
    return result.settlement.captured > 0 ||
        result.delivered > 0 ||
        result.dropped > 0 ||
        result.failed > 0
        ? "progressed"
        : "idle";
}
//# sourceMappingURL=pass-results.js.map