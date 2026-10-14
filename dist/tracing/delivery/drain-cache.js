import { scopeKey, scopeOf } from "../../storage/capture/scope.js";
import { DELIVERY_RECEIPT_PERSIST_MESSAGE, DELIVERY_RECEIPT_READ_MESSAGE } from "./constants.js";
export function deliveryKey(scope, destination) {
    return JSON.stringify([scopeKey(scope), destination]);
}
export function createDrainCache(store) {
    const captures = new Map();
    const outcomes = new Map();
    return {
        dependentDrops: new Map(),
        read(scope) {
            const key = scopeKey(scope);
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
                throw new Error(`${DELIVERY_RECEIPT_PERSIST_MESSAGE} ${input.outcome} ${result.status}`);
            outcomes.set(deliveryKey(input, input.destination), Promise.resolve({
                status: "settled",
                receipt: result.receipt,
            }));
            return result.receipt;
        },
        rememberCapture(record) {
            captures.set(scopeKey(record), Promise.resolve(record));
        },
    };
}
export async function requireOutcome(drainCache, scope, destination) {
    const result = await drainCache.readOutcome(scope, destination);
    if (result.status === "failed" || result.status === "missing-capture")
        throw new Error(`${DELIVERY_RECEIPT_READ_MESSAGE} ${result.status}`);
    return result;
}
export async function countPending(drainCache, entries, destinations) {
    let count = 0;
    let nextRetryAtMs;
    for (const entry of entries) {
        const scope = scopeOf(entry.record);
        for (const destination of destinations) {
            if ((await requireOutcome(drainCache, scope, destination.id)).status !== "pending")
                continue;
            count += 1;
            const retry = entry.record.delivery?.retries[destination.id];
            if (retry !== undefined && (nextRetryAtMs === undefined || retry.notBeforeMs < nextRetryAtMs))
                nextRetryAtMs = retry.notBeforeMs;
        }
    }
    return nextRetryAtMs === undefined ? { count } : { count, nextRetryAtMs };
}
//# sourceMappingURL=drain-cache.js.map