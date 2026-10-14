import { createCaptureStore } from "../../storage/capture/index.js";
export async function requireDeliveredCompactionReceipts(captureStore, captures, destinations) {
    for (const { record } of captures) {
        if (record.compaction === undefined)
            continue;
        const scope = scopeOf(record);
        for (const destination of destinations) {
            const outcome = await captureStore.readOutcome(scope, destination.id);
            if (outcome.status === "failed")
                throw new Error(`Could not verify compacted capture receipt: ${outcome.code}`);
            if (outcome.status !== "settled" || outcome.receipt.outcome !== "delivered") {
                throw new Error(`Compacted capture ${record.eventId} has no delivered receipt for destination ${destination.id}`);
            }
        }
    }
}
export function createDrainCache(store) {
    const captures = new Map();
    const outcomes = new Map();
    return {
        read(scope) {
            const key = captureKey(scope);
            let record = captures.get(key);
            if (record === undefined) {
                record = store.read(scope);
                captures.set(key, record);
            }
            return record;
        },
        readOutcome(scope, destination) {
            const key = deliveryKey(scope, destination);
            let outcome = outcomes.get(key);
            if (outcome === undefined) {
                outcome = store.readOutcome(scope, destination);
                outcomes.set(key, outcome);
            }
            return outcome;
        },
        async recordOutcome(input) {
            const result = await store.recordOutcome(input);
            if (result.status !== "recorded" && result.status !== "duplicate")
                throw new Error(`Could not persist ${input.outcome} delivery receipt: ${result.status}`);
            outcomes.set(deliveryKey(input, input.destination), Promise.resolve({
                status: "settled",
                receipt: result.receipt,
            }));
            return result.receipt;
        },
        rememberCapture(record) {
            captures.set(captureKey(record), Promise.resolve(record));
        },
    };
}
function captureKey(scope) {
    return JSON.stringify([scope.integration, scope.sessionId, scope.turnId, scope.eventId]);
}
export function deliveryKey(scope, destination) {
    return JSON.stringify([
        scope.integration,
        scope.sessionId,
        scope.turnId,
        scope.eventId,
        destination,
    ]);
}
export async function requireOutcome(drainCache, scope, destination) {
    const result = await drainCache.readOutcome(scope, destination);
    if (result.status === "failed" || result.status === "missing-capture")
        throw new Error(`Could not read delivery receipt: ${result.status}`);
    return result;
}
export async function countPending(drainCache, entries, destinations) {
    let count = 0;
    for (const entry of entries) {
        const scope = scopeOf(entry.record);
        for (const destination of destinations) {
            const outcome = await requireOutcome(drainCache, scope, destination.id);
            if (outcome.status === "pending")
                count += 1;
        }
    }
    return count;
}
export function scopeOf(record) {
    return {
        integration: record.integration,
        sessionId: record.sessionId,
        turnId: record.turnId,
        eventId: record.eventId,
    };
}
//# sourceMappingURL=coordinator-receipts.js.map