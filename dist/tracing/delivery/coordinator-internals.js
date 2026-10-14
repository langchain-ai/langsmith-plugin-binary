import { createCaptureStore } from "../../storage/capture/index.js";
import { createDeliveryAttemptStore } from "./attempt-store.js";
import { DELIVERY_CAPACITY_REASON, DELIVERY_DEPENDENCY_DROPPED_REASON, DELIVERY_EXPIRED_REASON, DELIVERY_RETRY_EXHAUSTED_REASON, } from "./constants.js";
import { dependenciesForDestination, dropPending, pendingCandidates, recordDroppedDestination, removeDroppedDependencies, } from "./coordinator-dependencies.js";
import { deliveryKey } from "./coordinator-receipts.js";
export async function drainLocked(captureStore, attemptStore, integration, sessionId, policy, request, drainCache) {
    const captures = await captureStore.enumerate(integration, sessionId);
    const eligible = captures.filter(({ record }) => record.destinationFingerprint === request.writer.accountFingerprint &&
        record.compaction === undefined);
    for (const { record } of eligible)
        drainCache.rememberCapture(record);
    const counts = { delivered: 0, dropped: 0, failed: 0 };
    const now = request.now ?? Date.now();
    const candidates = await pendingCandidates(drainCache, eligible, request.writer.destinations);
    for (const candidate of candidates) {
        counts.dropped += await removeDroppedDependencies(drainCache, candidate);
    }
    const active = candidates.filter((candidate) => candidate.pending.length > 0);
    const expired = active.filter(({ entry }) => ageMs(entry, now) >= policy.maxAgeMs);
    for (const candidate of expired) {
        counts.dropped += await dropPending(drainCache, candidate, DELIVERY_EXPIRED_REASON);
    }
    const fresh = active.filter(({ entry }) => ageMs(entry, now) < policy.maxAgeMs);
    const overCapacity = Math.max(0, fresh.length - policy.maxEntries);
    for (const candidate of fresh.slice(0, overCapacity)) {
        counts.dropped += await dropPending(drainCache, candidate, DELIVERY_CAPACITY_REASON);
    }
    const sendable = fresh.slice(overCapacity);
    const context = {
        attempted: new Set(),
        attemptStore,
        policy,
        request,
        drainCache,
        counts,
        now,
    };
    let progressed;
    do {
        progressed = await processSendableCandidates(sendable, context);
    } while (progressed);
    return counts;
}
function ageMs(entry, now) {
    return now - (entry.record.sourceAgeStartedAtMs ?? entry.capturedAtMs);
}
async function processSendableCandidates(candidates, context) {
    let progressed = false;
    for (const candidate of candidates) {
        for (const destination of candidate.pending) {
            const key = deliveryKey(candidate.scope, destination.id);
            if (context.attempted.has(key))
                continue;
            const destinationProgress = await processDestination(candidate, destination, key, context);
            if (destinationProgress)
                progressed = true;
        }
    }
    return progressed;
}
async function processDestination(candidate, destination, key, context) {
    const { attempted, attemptStore, policy, request, drainCache, counts, now } = context;
    const dependencyState = await dependenciesForDestination(drainCache, candidate.entry.record, destination.id);
    if (dependencyState === "pending")
        return false;
    attempted.add(key);
    if (dependencyState === "dropped") {
        counts.dropped += await recordDroppedDestination(drainCache, candidate, destination.id, DELIVERY_DEPENDENCY_DROPPED_REASON);
        return true;
    }
    const attemptCount = await attemptStore.count(candidate.scope, destination.id);
    const remainingAttempts = policy.maxAttempts - (candidate.entry.record.priorDeliveryAttempts ?? 0);
    if (attemptCount >= remainingAttempts) {
        counts.dropped += await recordDroppedDestination(drainCache, candidate, destination.id, DELIVERY_RETRY_EXHAUSTED_REASON);
        return true;
    }
    const attempt = attemptCount + 1;
    await attemptStore.record(candidate.scope, destination.id, attempt, new Date(now).toISOString());
    if (candidate.entry.record.destinationFingerprint !== request.writer.accountFingerprint)
        return false;
    try {
        await request.writer.send(structuredClone(candidate.entry.record), destination, request.writer.accountFingerprint);
    }
    catch {
        counts.failed += 1;
        if (attempt < remainingAttempts)
            return false;
        counts.dropped += await recordDroppedDestination(drainCache, candidate, destination.id, DELIVERY_RETRY_EXHAUSTED_REASON);
        return true;
    }
    await drainCache.recordOutcome({
        ...candidate.scope,
        destination: destination.id,
        outcome: "delivered",
    });
    counts.delivered += 1;
    return true;
}
//# sourceMappingURL=coordinator-internals.js.map