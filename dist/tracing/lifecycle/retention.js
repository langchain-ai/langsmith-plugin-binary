import { captureContentDigest } from "../../storage/capture/compaction.js";
import { LIFECYCLE_PATCH_EVENT_KIND, LIFECYCLE_POST_EVENT_KIND } from "./constants.js";
import { withLifecycleSnapshotLock } from "./snapshot.js";
export async function compactSettledCaptures(options) {
    const captures = options.eligibleCaptures;
    const runs = new Map();
    for (const { record } of captures) {
        if (record.destinationFingerprint !== options.destinationFingerprint || !isRunPayload(record)) {
            continue;
        }
        const key = JSON.stringify([record.turnId, record.runId]);
        const run = runs.get(key) ?? { turnId: record.turnId, runId: record.runId, records: [] };
        run.records.push(record);
        runs.set(key, run);
    }
    for (const [key, run] of runs) {
        if (run.records.every((record) => record.compaction !== undefined))
            runs.delete(key);
    }
    if (runs.size === 0)
        return 0;
    const settledTurns = new Set(options.settledTurnIds);
    let compacted = 0;
    for (const { turnId, runId, records } of runs.values()) {
        if (!settledTurns.has(turnId))
            continue;
        await withLifecycleSnapshotLock(options, turnId, runId, async () => {
            const current = await options.store.enumerateTurn(options.integration, options.sessionId, turnId);
            const currentRecords = current
                .filter(({ record }) => record.turnId === turnId &&
                record.runId === runId &&
                record.destinationFingerprint === options.destinationFingerprint &&
                isRunPayload(record))
                .map(({ record }) => record);
            if (!sameRunRecords(records, currentRecords))
                return;
            for (const record of currentRecords) {
                if (record.compaction !== undefined)
                    continue;
                if (!(await hasDeliveredReceipts(record, options.destinations, options.readOutcome)))
                    continue;
                const result = await options.store.compact(captureScope(record), record);
                if (result.status === "failed")
                    throw new Error(`Capture compaction failed: ${result.code}`);
                if (result.status === "compacted")
                    compacted += 1;
            }
        });
    }
    return compacted;
}
function sameRunRecords(expected, current) {
    if (expected.length !== current.length)
        return false;
    const currentByEventId = new Map(current.map((record) => [record.eventId, record]));
    return expected.every((record) => {
        const found = currentByEventId.get(record.eventId);
        return found !== undefined && captureContentDigest(found) === captureContentDigest(record);
    });
}
function isRunPayload(record) {
    return (record.eventKind === LIFECYCLE_POST_EVENT_KIND ||
        record.eventKind === LIFECYCLE_PATCH_EVENT_KIND);
}
async function hasDeliveredReceipts(record, destinations, readOutcome) {
    const scope = captureScope(record);
    for (const destination of destinations) {
        const outcome = await readOutcome(scope, destination.id);
        if (outcome.status === "failed")
            throw new Error(`Could not read capture receipt: ${outcome.code}`);
        if (outcome.status !== "settled" || outcome.receipt.outcome !== "delivered")
            return false;
    }
    return true;
}
function captureScope(record) {
    return {
        integration: record.integration,
        sessionId: record.sessionId,
        turnId: record.turnId,
        eventId: record.eventId,
    };
}
//# sourceMappingURL=retention.js.map