import { buildCodingAgentMetadata } from "../../metadata/index.js";
import { fillTemplate } from "../../utils/format.js";
import { canonicalJsonValue } from "../../utils/validation/objects.js";
import { LIFECYCLE_ATTRIBUTION_READY_FIELD, LIFECYCLE_SETTLEMENT_EVENT_KIND, } from "../lifecycle/constants.js";
import { SETTLEMENT_ATTRIBUTION_LOST_MESSAGE, SETTLEMENT_DROPPED_RUN_WARNING, SETTLEMENT_NEVER_ENDED_WARNING, SETTLEMENT_QUIET_TURN_MS, } from "./constants.js";
import { recordRun, mergeMetadataOptions } from "./recorded-run.js";
import { settlementEventId } from "./revision.js";
import { capturedEndTime, hasCausalRunError, retainedEndTime } from "./run-state.js";
import { attributionOf, metadataAfterFill, turnAttribution } from "./settlement.js";
import { orderSourceCaptures, report, uniqueScopes } from "./source-order.js";
import { addAttribution, closureRank, parseEvidence, patchPayload } from "./projection.js";
import { scopeOf } from "../../storage/capture/scope.js";
function unsettled(settlementReport) {
    return { report: settlementReport, patches: [], captured: 0 };
}
function collectTurnEvidence(events) {
    const rootRunIds = new Set();
    const childRunIds = new Set();
    let closureState = "open";
    for (const event of events) {
        const evidence = parseEvidence(event.record.turnEvidence, event.attributionReady);
        if (evidence.rootRunId !== undefined)
            rootRunIds.add(evidence.rootRunId);
        for (const childRunId of evidence.childRunIds)
            childRunIds.add(childRunId);
        if (closureRank(evidence.closureState) > closureRank(closureState)) {
            closureState = evidence.closureState;
        }
    }
    return { rootRunIds, childRunIds, closureState };
}
function evidenceResult(turnId, events, { rootRunIds, closureState }, isQuiet) {
    if (rootRunIds.size === 0)
        return unsettled(report(turnId, "deferred", "missing-root"));
    if (rootRunIds.size > 1)
        return unsettled(report(turnId, "blocked", "conflicting-root", [...rootRunIds].toSorted()));
    if (closureState === "authoritative")
        return undefined;
    if (!isQuiet)
        return unsettled(report(turnId, "deferred", closureState));
    if (!isChildTurn(events, [...rootRunIds][0]))
        warnAboutNeverEndedTurn(turnId);
    return undefined;
}
function isChildTurn(events, rootRunId) {
    return events.some(({ record, payload }) => record.runId === rootRunId && payload.run.parent_run_id !== undefined);
}
const warnedNeverEndedTurns = new Set();
function warnAboutNeverEndedTurn(turnId) {
    if (warnedNeverEndedTurns.has(turnId))
        return;
    warnedNeverEndedTurns.add(turnId);
    console.warn(fillTemplate(SETTLEMENT_NEVER_ENDED_WARNING, { turnId }));
}
function isQuietTurn(events, now) {
    return (events.length > 0 &&
        now - Math.max(...events.map(({ record }) => record.capturedAtMs)) >= SETTLEMENT_QUIET_TURN_MS);
}
function groupByRunId(events) {
    const grouped = new Map();
    for (const event of events) {
        const runEvents = grouped.get(event.record.runId) ?? [];
        runEvents.push(event);
        grouped.set(event.record.runId, runEvents);
    }
    return grouped;
}
function requiredRunEvents(requiredRunIds, rootRunId, currentByRunId, allByRunId) {
    const byRunId = new Map();
    for (const runId of requiredRunIds) {
        byRunId.set(runId, runId === rootRunId ? (currentByRunId.get(runId) ?? []) : (allByRunId.get(runId) ?? []));
    }
    return byRunId;
}
function buildTurnRecord(turnId, rootRunId, requiredRunIds, recorded) {
    return {
        path: "",
        origin: "capture",
        root: recorded.get(rootRunId),
        children: requiredRunIds
            .filter((runId) => runId !== rootRunId)
            .map((runId) => recorded.get(runId)),
        turnId,
        closed: true,
        delivered: new Set(requiredRunIds),
        fixed: new Set(),
    };
}
function planRunPatch(state, runId) {
    const { attribution, captureEvents, recorded } = state;
    const events = captureEvents.get(runId);
    const run = recorded.get(runId);
    const merged = attribution === undefined ? undefined : metadataAfterFill(run, attribution);
    const currentAttribution = attributionOf(run.metadata);
    const added = Object.fromEntries(Object.entries(merged === undefined ? {} : (attribution ?? {})).filter(([key]) => currentAttribution[key] === undefined));
    const endTime = retainedEndTime(events);
    const restoreEndTime = endTime !== undefined &&
        events.some((event) => (event.metadata.runType === "tool" || event.metadata.runType === "root") &&
            !event.attributionReady &&
            capturedEndTime(event) !== undefined);
    if (Object.keys(added).length === 0 && !restoreEndTime)
        return undefined;
    const sourceMetadata = mergeMetadataOptions(events);
    const metadata = Object.keys(added).length === 0 ? sourceMetadata : addAttribution(sourceMetadata, added);
    const updatedMetadata = buildCodingAgentMetadata(metadata);
    if (Object.entries(added).some(([key, value]) => updatedMetadata[key] !== value))
        throw new Error(SETTLEMENT_ATTRIBUTION_LOST_MESSAGE);
    if (endTime === undefined && !state.quiet)
        return undefined;
    return { metadata, added, endTime: endTime ?? lastCapturedTime(events) };
}
function lastCapturedTime(events) {
    return new Date(Math.max(...events.map(({ record }) => record.capturedAtMs))).toISOString();
}
const warnedDroppedRuns = new Set();
function warnAboutDroppedRuns(turnId, runIds) {
    for (const runId of runIds) {
        const key = JSON.stringify([turnId, runId]);
        if (warnedDroppedRuns.has(key))
            continue;
        warnedDroppedRuns.add(key);
        console.warn(fillTemplate(SETTLEMENT_DROPPED_RUN_WARNING, { runId }));
    }
}
function settlementCaptureInput(state, generated, options, runId, plan) {
    const { turnId, rootRunId, childRunIds, closureState, dependencies, captureEvents } = state;
    const events = captureEvents.get(runId);
    const latest = events.at(-1);
    const submission = patchPayload(latest, plan.metadata, options.integration, plan.endTime, hasCausalRunError(events), events);
    const eventId = settlementEventId(turnId, runId, dependencies, rootRunId, childRunIds, plan.added);
    const previous = orderSourceCaptures(generated.filter((item) => item.runId === runId && item.eventId !== eventId)).at(-1);
    const previousDependency = previous === undefined ? [] : [scopeOf(previous)];
    return {
        scope: {
            integration: options.integration,
            sessionId: options.sessionId,
            turnId,
            eventId,
        },
        input: {
            turnId,
            eventId,
            runId,
            destinationFingerprint: options.destinationFingerprint,
            eventKind: LIFECYCLE_SETTLEMENT_EVENT_KIND,
            normalizedPayload: canonicalJsonValue(submission.payload),
            metadataProvenance: canonicalJsonValue(submission.metadata),
            turnEvidence: canonicalJsonValue({
                rootRunId,
                childRunIds: [...childRunIds].toSorted(),
                closureState,
                [LIFECYCLE_ATTRIBUTION_READY_FIELD]: latest.attributionReady,
            }),
            dependencies: uniqueScopes([...dependencies, ...previousDependency]),
        },
    };
}
async function captureRunPatch(state, generated, options, runId, plan) {
    const { input, scope } = settlementCaptureInput(state, generated, options, runId, plan);
    const result = await options.capture(input);
    if (result.status === "failed" || result.status === "conflict") {
        throw new Error(`Could not capture settled run ${runId}: ${result.status}`);
    }
    return {
        patch: { turnId: state.turnId, runId, scope },
        published: result.status === "published",
    };
}
async function captureTurnPatches(state, requiredRunIds, currentByRunId, generated, options) {
    const patches = [];
    let captured = 0;
    for (const runId of requiredRunIds) {
        if (!currentByRunId.has(runId))
            continue;
        const plan = planRunPatch(state, runId);
        if (plan === undefined)
            continue;
        const outcome = await captureRunPatch(state, generated, options, runId, plan);
        if (outcome.published)
            captured += 1;
        patches.push(outcome.patch);
    }
    const reportResult = report(state.turnId, patches.length === 0 ? "settled" : "pending", patches.length === 0 ? "no-change" : "settlement-pending", patches.map(({ runId }) => runId));
    return {
        report: {
            ...reportResult,
            patches: patches.length,
            settled: { rootRunId: state.rootRunId, attribution: state.attribution ?? {} },
        },
        patches,
        captured,
    };
}
function hasRootPost(events, evidence) {
    const [rootRunId] = evidence.rootRunIds;
    return (evidence.rootRunIds.size === 1 &&
        events.some(({ payload, record }) => record.runId === rootRunId && payload.operation === "post"));
}
async function settleLateRuns(turnId, events, generated, settledTurn, options) {
    const currentByRunId = groupByRunId(events);
    const runIds = [...currentByRunId.keys()].filter((runId) => runId !== settledTurn.rootRunId &&
        currentByRunId.get(runId).some(({ payload }) => payload.operation === "post"));
    const state = {
        turnId,
        rootRunId: settledTurn.rootRunId,
        childRunIds: new Set(runIds),
        closureState: "authoritative",
        quiet: isQuietTurn(events, options.now ?? Date.now()),
        dependencies: uniqueScopes(events.map(({ record }) => scopeOf(record))),
        attribution: Object.keys(settledTurn.attribution).length === 0 ? undefined : settledTurn.attribution,
        recorded: new Map(runIds.map((runId) => [runId, recordRun(currentByRunId.get(runId))])),
        captureEvents: currentByRunId,
    };
    return captureTurnPatches(state, runIds, currentByRunId, generated, options);
}
export async function settleOneTurn(turnId, events, generated, allByRunId, options) {
    const evidence = collectTurnEvidence(events);
    const settledTurn = hasRootPost(events, evidence) ? undefined : await options.settledTurn(turnId);
    if (settledTurn !== undefined)
        return settleLateRuns(turnId, events, generated, settledTurn, options);
    const quiet = isQuietTurn(events, options.now ?? Date.now());
    const early = evidenceResult(turnId, events, evidence, quiet);
    if (early !== undefined)
        return early;
    const { childRunIds, closureState } = evidence;
    const rootRunId = [...evidence.rootRunIds][0];
    childRunIds.delete(rootRunId);
    const droppedRunIds = await options.droppedRunIds(turnId);
    if (droppedRunIds.has(rootRunId))
        return unsettled(report(turnId, "blocked", "source-dropped", [rootRunId]));
    warnAboutDroppedRuns(turnId, [...childRunIds].filter((runId) => droppedRunIds.has(runId)));
    const requiredRunIds = [
        rootRunId,
        ...[...childRunIds].filter((runId) => !droppedRunIds.has(runId)).toSorted(),
    ];
    const currentByRunId = groupByRunId(events);
    const captureEvents = requiredRunEvents(requiredRunIds, rootRunId, currentByRunId, allByRunId);
    const missingRunId = requiredRunIds.find((runId) => !captureEvents.get(runId).some(({ payload }) => payload.operation === "post"));
    if (missingRunId !== undefined)
        return unsettled(report(turnId, "deferred", "missing-run", [missingRunId]));
    const sourceEvents = [...events];
    for (const childRunId of childRunIds) {
        sourceEvents.push(...(allByRunId.get(childRunId) ?? []));
    }
    const sourceScopes = uniqueScopes(sourceEvents.map(({ record }) => scopeOf(record)));
    const recorded = new Map(requiredRunIds.map((runId) => [runId, recordRun(captureEvents.get(runId))]));
    const state = {
        turnId,
        rootRunId,
        childRunIds,
        closureState,
        quiet,
        dependencies: sourceScopes,
        attribution: turnAttribution(buildTurnRecord(turnId, rootRunId, requiredRunIds, recorded)),
        recorded,
        captureEvents,
    };
    return captureTurnPatches(state, requiredRunIds, currentByRunId, generated, options);
}
//# sourceMappingURL=settle-turn.js.map