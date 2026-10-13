import { LIFECYCLE_PATCH_EVENT_KIND, LIFECYCLE_POST_EVENT_KIND, LIFECYCLE_SETTLEMENT_EVENT_KIND, } from "../lifecycle/constants.js";
import { captureReadiness } from "./readiness.js";
import { projectCapture } from "./projection.js";
import { settleOneTurn } from "./settle-turn.js";
import { groupByTurn, orderSourceCaptures } from "./source-order.js";
export async function settleCapturedTurns(options) {
    if (options.destinations.length === 0)
        throw new TypeError("At least one settlement destination is required");
    const sourceRecords = orderSourceCaptures(options.captures
        .map(({ record }) => record)
        .filter((record) => record.integration === options.integration &&
        record.sessionId === options.sessionId &&
        record.destinationFingerprint === options.destinationFingerprint &&
        (record.eventKind === LIFECYCLE_POST_EVENT_KIND ||
            record.eventKind === LIFECYCLE_PATCH_EVENT_KIND)));
    const generatedRecords = options.captures
        .map(({ record }) => record)
        .filter((record) => record.integration === options.integration &&
        record.sessionId === options.sessionId &&
        record.destinationFingerprint === options.destinationFingerprint &&
        record.eventKind === LIFECYCLE_SETTLEMENT_EVENT_KIND);
    const projected = new Map();
    const allByRunId = new Map();
    for (const record of sourceRecords) {
        const capture = projectCapture(record, options.integration);
        if (capture === undefined)
            continue;
        const turn = projected.get(record.turnId) ?? [];
        turn.push(capture);
        projected.set(record.turnId, turn);
        const runEvents = allByRunId.get(record.runId) ?? [];
        runEvents.push(capture);
        allByRunId.set(record.runId, runEvents);
    }
    const generatedByTurn = groupByTurn(generatedRecords);
    const turns = [...new Set([...projected.keys(), ...generatedByTurn.keys()])].toSorted();
    const reports = [];
    const patches = [];
    let captured = 0;
    for (const turnId of turns) {
        const events = projected.get(turnId) ?? [];
        const generated = generatedByTurn.get(turnId) ?? [];
        const result = await settleOneTurn(turnId, events, generated, allByRunId, options);
        reports.push(result.report);
        patches.push(...result.patches);
        captured += result.captured;
    }
    return { progress: { captured, turns: reports }, patches };
}
export async function refreshSettlementProgress(work, destinations, readOutcome) {
    const patchesByTurn = new Map();
    for (const patch of work.patches) {
        const turn = patchesByTurn.get(patch.turnId) ?? [];
        turn.push(patch);
        patchesByTurn.set(patch.turnId, turn);
    }
    const turns = [];
    for (const entry of work.progress.turns) {
        const patches = patchesByTurn.get(entry.turnId) ?? [];
        if (patches.length === 0 || (entry.status !== "pending" && entry.status !== "settled")) {
            turns.push(entry);
            continue;
        }
        const readiness = await captureReadiness(patches.map(({ scope }) => scope), destinations, readOutcome);
        turns.push(refreshedReport(entry, readiness));
    }
    return { captured: work.progress.captured, turns };
}
function refreshedReport(entry, readiness) {
    const { reason: previousReason, destinations: previousDestinations, ...unchanged } = entry;
    let status = "settled";
    let reason = previousReason;
    if (readiness.status === "dropped") {
        status = "blocked";
        reason = "settlement-dropped";
    }
    else if (readiness.status === "pending") {
        status = "pending";
        reason = "settlement-pending";
    }
    else if (previousReason === "settlement-pending") {
        reason = undefined;
    }
    let destinations = previousDestinations;
    if (readiness.destinations.length > 0) {
        destinations = readiness.destinations;
    }
    else if (previousReason === "settlement-pending") {
        destinations = undefined;
    }
    return {
        ...unchanged,
        status,
        ...(reason === undefined ? {} : { reason }),
        ...(destinations === undefined ? {} : { destinations }),
    };
}
//# sourceMappingURL=pass.js.map