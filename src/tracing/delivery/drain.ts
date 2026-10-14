import { isWaitingForRetry } from "../../storage/capture/retry-state.js";
import type { CaptureStore, EnumeratedCapture } from "../../storage/capture/models.js";
import { scopeOf } from "../../storage/capture/scope.js";
import { fillTemplate } from "../../utils/format.js";
import { DELIVERY_CAPACITY_REASON, DELIVERY_DEPENDENTS_DROPPED_WARNING } from "./constants.js";
import { canJoinBatch, createBatch, joinBatch } from "./batch.js";
import { deliverBatch } from "./deliver.js";
import { deliveryKey, requireOutcome } from "./drain-cache.js";
import {
  addDestinationResult,
  dependenciesForDestination,
  dropDependents,
  emptyDestinationResult,
  recordDropped,
  settleDroppedDependency,
} from "./outcomes.js";
import type {
  DeliveryDestination,
  DeliveryDestinationResult,
  DeliveryDrainCache,
  DeliveryDrainCounts,
  DeliveryDrainPassContext,
  DeliveryPendingCandidate,
  DeliveryPolicy,
  DrainOptions,
} from "./models.js";

export async function drainLocked(
  captureStore: CaptureStore,
  integration: string,
  sessionId: string,
  policy: DeliveryPolicy,
  request: DrainOptions,
  drainCache: DeliveryDrainCache,
): Promise<DeliveryDrainCounts> {
  const captures = await captureStore.enumerate(integration, sessionId);
  const eligible = captures.filter(
    ({ record }) => record.destinationFingerprint === request.writer.accountFingerprint,
  );
  for (const { record } of eligible) drainCache.rememberCapture(record);
  let dropped = 0;
  let failed = 0;
  let delivered = 0;
  const candidates = await pendingCandidates(drainCache, eligible, request.writer.destinations);
  dropped += await dropDependents(drainCache, candidates);
  let active = candidates.filter((candidate) => candidate.pending.length > 0);
  const overflowing = turnsToDrop(active, policy.maxEntries);
  if (overflowing.size > 0) {
    for (const candidate of active.filter(({ scope }) => overflowing.has(scope.turnId))) {
      dropped += await dropPending(drainCache, candidate, DELIVERY_CAPACITY_REASON);
      candidate.pending = [];
    }
    active = candidates.filter((candidate) => candidate.pending.length > 0);
  }
  const context: DeliveryDrainPassContext = {
    captureStore,
    drainCache,
    policy,
    request,
    attempted: new Set<string>(),
    sendable: active,
  };
  let progressed: boolean;
  do {
    progressed = false;
    for (const destination of request.writer.destinations) {
      const result = await drainDestination(context, destination);
      delivered += result.delivered;
      dropped += result.dropped;
      failed += result.failed;
      progressed ||= result.progressed;
    }
  } while (progressed);
  warnAboutDependentDrops(drainCache);
  await removeDroppedCaptures(captureStore, drainCache, eligible, request.writer.destinations);
  return { delivered, dropped, failed };
}

async function drainDestination(
  context: DeliveryDrainPassContext,
  destination: DeliveryDestination,
): Promise<DeliveryDestinationResult> {
  const { drainCache, attempted, request } = context;
  const { writer } = request;
  const result = emptyDestinationResult();
  let batch = createBatch();
  const flush = async () => {
    if (batch.candidates.length > 0)
      addDestinationResult(result, await deliverBatch(context, destination, batch.candidates));
    batch = createBatch();
  };
  for (const candidate of context.sendable) {
    if (!candidate.pending.some(({ id }) => id === destination.id)) continue;
    const key = deliveryKey(candidate.scope, destination.id);
    if (attempted.has(key)) continue;
    const record = candidate.entry.record;
    const dependencyState = await dependenciesForDestination(
      drainCache,
      candidate.entry,
      destination.id,
      batch.scopes,
    );
    if (dependencyState === "pending") continue;
    const retry = record.delivery?.retries[destination.id];
    if (isWaitingForRetry(retry)) continue;
    const sendsNow =
      dependencyState === "ready" && record.destinationFingerprint === writer.accountFingerprint;
    if (sendsNow && !canJoinBatch(batch, candidate, writer)) {
      await flush();
      continue;
    }
    attempted.add(key);
    if (dependencyState === "dropped") {
      await settleDroppedDependency(drainCache, candidate, destination.id, result);
      continue;
    }
    if (!sendsNow) continue;
    joinBatch(batch, candidate);
  }
  await flush();
  return result;
}

function warnAboutDependentDrops(drainCache: DeliveryDrainCache): void {
  for (const [destination, runs] of drainCache.dependentDrops)
    console.warn(
      fillTemplate(DELIVERY_DEPENDENTS_DROPPED_WARNING, {
        destination,
        runs: [...runs].join(", "),
      }),
    );
}

async function removeDroppedCaptures(
  captureStore: CaptureStore,
  drainCache: DeliveryDrainCache,
  entries: EnumeratedCapture[],
  destinations: readonly DeliveryDestination[],
): Promise<void> {
  for (const { record } of entries) {
    const outcomes = await Promise.all(
      destinations.map(({ id }) => drainCache.readOutcome(scopeOf(record), id)),
    );
    if (
      outcomes.every(
        (outcome) => outcome.status === "settled" && outcome.receipt.outcome === "dropped",
      )
    )
      await captureStore.remove(scopeOf(record));
  }
}

function turnsToDrop(active: readonly DeliveryPendingCandidate[], maxEntries: number): Set<string> {
  const sizes = new Map<string, number>();
  for (const { scope } of active) sizes.set(scope.turnId, (sizes.get(scope.turnId) ?? 0) + 1);
  const dropping = new Set<string>();
  let remaining = active.length;
  for (const [turnId, size] of sizes) {
    if (remaining <= maxEntries) break;
    dropping.add(turnId);
    remaining -= size;
  }
  return dropping;
}

async function pendingCandidates(
  drainCache: DeliveryDrainCache,
  entries: EnumeratedCapture[],
  destinations: readonly DeliveryDestination[],
): Promise<DeliveryPendingCandidate[]> {
  const candidates: DeliveryPendingCandidate[] = [];
  for (const entry of entries) {
    const scope = scopeOf(entry.record);
    const pending: DeliveryDestination[] = [];
    for (const destination of destinations) {
      if ((await requireOutcome(drainCache, scope, destination.id)).status === "pending")
        pending.push(destination);
    }
    if (pending.length > 0) candidates.push({ entry, scope, pending });
  }
  return candidates;
}

async function dropPending(
  drainCache: DeliveryDrainCache,
  candidate: DeliveryPendingCandidate,
  reason: string,
): Promise<number> {
  let dropped = 0;
  for (const destination of candidate.pending) {
    dropped += await recordDropped(drainCache, candidate, destination.id, { reason });
  }
  return dropped;
}
