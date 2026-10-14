import type { BackgroundWorkerPassResult } from "../background-worker/models.js";
import type { LifecycleDrainResult } from "../lifecycle/models.js";
import type { ReconstructionDrainResult } from "../reconstruction/models.js";
import type { RetryState } from "./models.js";

export function reconstructionPassResult(
  result: ReconstructionDrainResult,
): BackgroundWorkerPassResult {
  if (result.status === "busy") return "retryable-failure";
  if (waitingOnBackoff(result)) return "deferred";
  return result.captured > 0 || result.dropped > 0 ? "progressed" : "idle";
}

export function lifecyclePassResult(result: LifecycleDrainResult): BackgroundWorkerPassResult {
  if (result.status === "busy") return "retryable-failure";
  if (waitingOnBackoff(result)) return "deferred";
  return result.settlement.captured > 0 || result.delivered > 0 || result.dropped > 0
    ? "progressed"
    : "idle";
}

function waitingOnBackoff(result: RetryState): boolean {
  return result.pending > 0 && result.nextRetryAtMs !== undefined;
}
