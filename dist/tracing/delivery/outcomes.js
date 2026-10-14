import { scopeKey } from "../../storage/capture/scope.js";
import { fillTemplate } from "../../utils/format.js";
import { DELIVERY_DEPENDENCY_DROPPED_REASON, DELIVERY_DROPPED_DETAIL, DELIVERY_DROPPED_WARNING, DELIVERY_PREREQUISITE_READ_MESSAGE, } from "./constants.js";
import { authHint } from "./retry.js";
export function emptyDestinationResult() {
    return { delivered: 0, dropped: 0, failed: 0, progressed: false };
}
export function addDestinationResult(total, part) {
    total.delivered += part.delivered;
    total.dropped += part.dropped;
    total.failed += part.failed;
    total.progressed ||= part.progressed;
}
export async function dependenciesForDestination(drainCache, entry, destination, inBatch = new Set()) {
    const dependent = entry.record;
    let pending = false;
    for (const dependency of dependent.dependencies ?? []) {
        if (inBatch.has(scopeKey(dependency)))
            continue;
        const prerequisite = await drainCache.read(dependency);
        if (prerequisite !== undefined &&
            prerequisite.destinationFingerprint !== dependent.destinationFingerprint) {
            pending = true;
            continue;
        }
        const outcome = await drainCache.readOutcome(dependency, destination);
        if (outcome.status === "failed")
            throw new Error(`${DELIVERY_PREREQUISITE_READ_MESSAGE} ${outcome.status}`);
        if (outcome.status === "pending" || outcome.status === "missing-capture") {
            pending = true;
            continue;
        }
        if (outcome.receipt.outcome === "dropped")
            return "dropped";
    }
    return pending ? "pending" : "ready";
}
export async function recordDropped(drainCache, candidate, destination, { reason, status }) {
    const { scope, entry } = candidate;
    await drainCache.recordOutcome({ ...scope, destination, outcome: "dropped", reason });
    if (reason === DELIVERY_DEPENDENCY_DROPPED_REASON) {
        const runs = drainCache.dependentDrops.get(destination) ?? new Set();
        drainCache.dependentDrops.set(destination, runs.add(entry.record.runId));
        return 1;
    }
    console.warn(DELIVERY_DROPPED_WARNING, fillTemplate(DELIVERY_DROPPED_DETAIL, {
        eventId: scope.eventId,
        runId: entry.record.runId,
        destination,
        reason,
        hint: authHint(status),
    }));
    return 1;
}
function dropAsDependent(drainCache, candidate, destination) {
    return recordDropped(drainCache, candidate, destination, {
        reason: DELIVERY_DEPENDENCY_DROPPED_REASON,
    });
}
export async function dropDependents(drainCache, candidates) {
    let dropped = 0;
    let changed;
    do {
        changed = false;
        for (const candidate of candidates) {
            const pending = [];
            for (const destination of candidate.pending) {
                const state = await dependenciesForDestination(drainCache, candidate.entry, destination.id);
                if (state === "dropped") {
                    dropped += await dropAsDependent(drainCache, candidate, destination.id);
                    changed = true;
                }
                else
                    pending.push(destination);
            }
            candidate.pending = pending;
        }
    } while (changed);
    return dropped;
}
export async function settleDroppedDependency(drainCache, candidate, destination, result) {
    result.dropped += await dropAsDependent(drainCache, candidate, destination);
    result.progressed = true;
}
//# sourceMappingURL=outcomes.js.map