import { isWaitingForRetry } from "../../storage/capture/retry-state.js";
import { scopeOf } from "../../storage/capture/scope.js";
import { fillTemplate } from "../../utils/format.js";
import { DELIVERY_CAPACITY_REASON, DELIVERY_DEPENDENTS_DROPPED_WARNING } from "./constants.js";
import { canJoinBatch, createBatch, joinBatch } from "./batch.js";
import { deliverBatch } from "./deliver.js";
import { deliveryKey, requireOutcome } from "./drain-cache.js";
import { addDestinationResult, dependenciesForDestination, dropDependents, emptyDestinationResult, recordDropped, settleDroppedDependency, } from "./outcomes.js";
export async function drainLocked(captureStore, integration, sessionId, policy, request, drainCache) {
    const captures = await captureStore.enumerate(integration, sessionId);
    const eligible = captures.filter(({ record }) => record.destinationFingerprint === request.writer.accountFingerprint);
    for (const { record } of eligible)
        drainCache.rememberCapture(record);
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
    const context = {
        captureStore,
        drainCache,
        policy,
        request,
        attempted: request.attempted ?? new Set(),
        sendable: active,
    };
    let progressed;
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
async function drainDestination(context, destination) {
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
        if (!candidate.pending.some(({ id }) => id === destination.id))
            continue;
        const key = deliveryKey(candidate.scope, destination.id);
        if (attempted.has(key))
            continue;
        const record = candidate.entry.record;
        const dependencyState = await dependenciesForDestination(drainCache, candidate.entry, destination.id, batch.scopes);
        if (dependencyState === "pending")
            continue;
        const retry = record.delivery?.retries[destination.id];
        if (isWaitingForRetry(retry))
            continue;
        const sendsNow = dependencyState === "ready" && record.destinationFingerprint === writer.accountFingerprint;
        if (sendsNow && !canJoinBatch(batch, candidate, writer)) {
            await flush();
            continue;
        }
        attempted.add(key);
        if (dependencyState === "dropped") {
            await settleDroppedDependency(drainCache, candidate, destination.id, result);
            continue;
        }
        if (!sendsNow)
            continue;
        joinBatch(batch, candidate);
    }
    await flush();
    return result;
}
function warnAboutDependentDrops(drainCache) {
    for (const [destination, runs] of drainCache.dependentDrops)
        console.warn(fillTemplate(DELIVERY_DEPENDENTS_DROPPED_WARNING, {
            destination,
            runs: [...runs].join(", "),
        }));
}
async function removeDroppedCaptures(captureStore, drainCache, entries, destinations) {
    for (const { record } of entries) {
        const outcomes = await Promise.all(destinations.map(({ id }) => drainCache.readOutcome(scopeOf(record), id)));
        if (outcomes.every((outcome) => outcome.status === "settled" && outcome.receipt.outcome === "dropped"))
            await captureStore.remove(scopeOf(record));
    }
}
function turnsToDrop(active, maxEntries) {
    const sizes = new Map();
    for (const { scope } of active)
        sizes.set(scope.turnId, (sizes.get(scope.turnId) ?? 0) + 1);
    const dropping = new Set();
    let remaining = active.length;
    for (const [turnId, size] of sizes) {
        if (remaining <= maxEntries)
            break;
        dropping.add(turnId);
        remaining -= size;
    }
    return dropping;
}
async function pendingCandidates(drainCache, entries, destinations) {
    const candidates = [];
    for (const entry of entries) {
        const scope = scopeOf(entry.record);
        const pending = [];
        for (const destination of destinations) {
            if ((await requireOutcome(drainCache, scope, destination.id)).status === "pending")
                pending.push(destination);
        }
        if (pending.length > 0)
            candidates.push({ entry, scope, pending });
    }
    return candidates;
}
async function dropPending(drainCache, candidate, reason) {
    let dropped = 0;
    for (const destination of candidate.pending) {
        dropped += await recordDropped(drainCache, candidate, destination.id, { reason });
    }
    return dropped;
}
//# sourceMappingURL=drain.js.map