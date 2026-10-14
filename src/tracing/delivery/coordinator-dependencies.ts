import type { EnumeratedCapture, StoredCapture } from "../../storage/capture/models.js";
import { DELIVERY_DEPENDENCY_DROPPED_REASON } from "./constants.js";
import { requireOutcome, scopeOf } from "./coordinator-receipts.js";
import type {
  DeliveryDependencyState,
  DeliveryDrainCache,
  DeliveryDestination,
  DeliveryPendingCandidate,
} from "./models.js";

export async function pendingCandidates(
  drainCache: DeliveryDrainCache,
  entries: EnumeratedCapture[],
  destinations: readonly DeliveryDestination[],
): Promise<DeliveryPendingCandidate[]> {
  const candidates: DeliveryPendingCandidate[] = [];
  for (const entry of entries) {
    const scope = scopeOf(entry.record);
    const pending: DeliveryDestination[] = [];
    for (const destination of destinations) {
      const outcome = await requireOutcome(drainCache, scope, destination.id);
      if (outcome.status === "pending") pending.push(destination);
    }
    if (pending.length > 0) candidates.push({ entry, scope, pending });
  }
  return candidates;
}

export async function removeDroppedDependencies(
  drainCache: DeliveryDrainCache,
  candidate: DeliveryPendingCandidate,
): Promise<number> {
  const pending: DeliveryDestination[] = [];
  let dropped = 0;
  for (const destination of candidate.pending) {
    const dependencyState = await dependenciesForDestination(
      drainCache,
      candidate.entry.record,
      destination.id,
    );
    if (dependencyState === "dropped") {
      dropped += await recordDroppedDestination(
        drainCache,
        candidate,
        destination.id,
        DELIVERY_DEPENDENCY_DROPPED_REASON,
      );
    } else {
      pending.push(destination);
    }
  }
  candidate.pending = pending;
  return dropped;
}

export async function dependenciesForDestination(
  drainCache: DeliveryDrainCache,
  dependent: StoredCapture,
  destination: string,
): Promise<DeliveryDependencyState> {
  let pending = false;
  for (const dependency of dependent.dependencies ?? []) {
    const prerequisite = await drainCache.read(dependency);
    if (prerequisite === undefined) {
      pending = true;
      continue;
    }
    if (prerequisite.destinationFingerprint !== dependent.destinationFingerprint) {
      pending = true;
      continue;
    }
    const outcome = await drainCache.readOutcome(dependency, destination);
    if (outcome.status === "failed")
      throw new Error(`Could not read prerequisite receipt: ${outcome.status}`);
    if (outcome.status === "pending" || outcome.status === "missing-capture") {
      pending = true;
      continue;
    }
    if (outcome.receipt.outcome === "dropped") return "dropped";
  }
  return pending ? "pending" : "ready";
}

export async function dropPending(
  drainCache: DeliveryDrainCache,
  candidate: DeliveryPendingCandidate,
  reason: string,
): Promise<number> {
  let dropped = 0;
  for (const destination of candidate.pending) {
    dropped += await recordDroppedDestination(drainCache, candidate, destination.id, reason);
  }
  return dropped;
}

export async function recordDroppedDestination(
  drainCache: DeliveryDrainCache,
  candidate: DeliveryPendingCandidate,
  destination: string,
  reason: string,
): Promise<number> {
  await drainCache.recordOutcome({
    ...candidate.scope,
    destination,
    outcome: "dropped",
    reason,
  });
  return 1;
}
