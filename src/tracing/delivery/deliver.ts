import { setTimeout as delay } from "node:timers/promises";
import {
  addDestinationResult,
  dependenciesForDestination,
  settleDroppedDependency,
  emptyDestinationResult,
  recordDropped,
} from "./outcomes.js";
import { isRetryable, nextRetry, rejection } from "./retry.js";
import type {
  DeliveryDestination,
  DeliveryDestinationResult,
  DeliveryDrainPassContext,
  DeliveryPendingCandidate,
} from "./models.js";

async function trySend(
  context: DeliveryDrainPassContext,
  destination: DeliveryDestination,
  candidates: readonly DeliveryPendingCandidate[],
): Promise<unknown> {
  const { policy, request } = context;
  const { writer } = request;
  const send = () =>
    writer.sendBatch(
      candidates.map(({ entry }) => structuredClone(entry.record)),
      destination,
      writer.accountFingerprint,
    );
  try {
    try {
      await send();
    } catch (error) {
      const first = candidates.every(
        ({ entry }) => entry.record.delivery?.retries[destination.id] === undefined,
      );
      if (!first || policy.quickRetryMs === 0 || !isRetryable(error)) throw error;
      await delay(policy.quickRetryMs);
      await send();
    }
  } catch (error) {
    return error ?? new Error();
  }
  return undefined;
}

async function settleDelivered(
  context: DeliveryDrainPassContext,
  destination: DeliveryDestination,
  candidates: readonly DeliveryPendingCandidate[],
): Promise<DeliveryDestinationResult> {
  const result = emptyDestinationResult();
  for (const candidate of candidates) {
    await context.drainCache.recordOutcome({
      ...candidate.scope,
      destination: destination.id,
      outcome: "delivered",
    });
    result.delivered += 1;
  }
  result.progressed = true;
  return result;
}

async function settleFailed(
  context: DeliveryDrainPassContext,
  destination: DeliveryDestination,
  candidates: readonly DeliveryPendingCandidate[],
  error: unknown,
): Promise<DeliveryDestinationResult> {
  const { captureStore, drainCache, policy } = context;
  const result = emptyDestinationResult();
  for (const candidate of candidates) {
    result.failed += 1;
    if (!isRetryable(error)) {
      result.dropped += await recordDropped(
        drainCache,
        candidate,
        destination.id,
        rejection(error),
      );
      result.progressed = true;
    } else {
      await captureStore.recordRetry(
        candidate.scope,
        destination.id,
        nextRetry(candidate.entry.record.delivery?.retries[destination.id], policy.retryBaseMs),
      );
    }
  }
  return result;
}

async function deliverOneByOne(
  context: DeliveryDrainPassContext,
  destination: DeliveryDestination,
  candidates: readonly DeliveryPendingCandidate[],
): Promise<DeliveryDestinationResult> {
  const result = emptyDestinationResult();
  for (const candidate of candidates) {
    const state = await dependenciesForDestination(
      context.drainCache,
      candidate.entry,
      destination.id,
    );
    if (state === "pending") continue;
    if (state === "dropped") {
      await settleDroppedDependency(context.drainCache, candidate, destination.id, result);
      continue;
    }
    const error = await trySend(context, destination, [candidate]);
    addDestinationResult(
      result,
      error === undefined
        ? await settleDelivered(context, destination, [candidate])
        : await settleFailed(context, destination, [candidate], error),
    );
  }
  return result;
}

export async function deliverBatch(
  context: DeliveryDrainPassContext,
  destination: DeliveryDestination,
  candidates: readonly DeliveryPendingCandidate[],
): Promise<DeliveryDestinationResult> {
  const error = await trySend(context, destination, candidates);
  if (error === undefined) return settleDelivered(context, destination, candidates);
  if (candidates.length > 1 && !isRetryable(error))
    return deliverOneByOne(context, destination, candidates);
  return settleFailed(context, destination, candidates, error);
}
