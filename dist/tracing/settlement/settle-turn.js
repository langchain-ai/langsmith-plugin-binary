import { canonicalJsonValue } from "../../utils/validation/objects.js";
import { buildCodingAgentMetadata } from "../../metadata/index.js";
import { LIFECYCLE_ATTRIBUTION_READY_FIELD, LIFECYCLE_SETTLEMENT_EVENT_KIND, } from "../lifecycle/constants.js";
import { captureReadiness } from "./readiness.js";
import { recordRun, mergeMetadataOptions } from "./recorded-run.js";
import { settlementEventId } from "./revision.js";
import { capturedEndTime, hasCausalRunError, retainedEndTime } from "./run-state.js";
import { attributionOf, metadataAfterFill, turnAttribution } from "./settlement.js";
import { captureScope, orderSourceCaptures, report, uniqueScopes } from "./source-order.js";
import { addAttribution, closureRank, parseEvidence, patchPayload } from "./projection.js";
export async function settleOneTurn(turnId, events, generated, allByRunId, options) {
    const rootRunIds = new Set();
    const childRunIds = new Set();
    let closureState = "open";
    for (const event of events) {
        const evidence = parseEvidence(event.record.turnEvidence, event.attributionReady);
        if (evidence.rootRunId !== undefined)
            rootRunIds.add(evidence.rootRunId);
        for (const childRunId of evidence.childRunIds)
            childRunIds.add(childRunId);
        if (closureRank(evidence.closureState) > closureRank(closureState))
            closureState = evidence.closureState;
    }
    if (rootRunIds.size === 0)
        return { report: report(turnId, "deferred", "missing-root"), patches: [], captured: 0 };
    if (rootRunIds.size > 1)
        return {
            report: report(turnId, "blocked", "conflicting-root", [...rootRunIds].toSorted()),
            patches: [],
            captured: 0,
        };
    if (closureState !== "authoritative") {
        return {
            report: report(turnId, "deferred", closureState),
            patches: [],
            captured: 0,
        };
    }
    const rootRunId = [...rootRunIds][0];
    childRunIds.delete(rootRunId);
    const requiredRunIds = [rootRunId, ...[...childRunIds].toSorted()];
    const currentByRunId = new Map();
    for (const event of events) {
        const runEvents = currentByRunId.get(event.record.runId) ?? [];
        runEvents.push(event);
        currentByRunId.set(event.record.runId, runEvents);
    }
    const byRunId = new Map();
    for (const runId of requiredRunIds) {
        const runEvents = runId === rootRunId ? (currentByRunId.get(runId) ?? []) : (allByRunId.get(runId) ?? []);
        byRunId.set(runId, runEvents);
        if (!runEvents.some(({ payload }) => payload.operation === "post")) {
            return {
                report: report(turnId, "deferred", "missing-run", [runId]),
                patches: [],
                captured: 0,
            };
        }
    }
    const sourceEvents = [...events];
    for (const childRunId of childRunIds) {
        sourceEvents.push(...(allByRunId.get(childRunId) ?? []));
    }
    const sourceScopes = uniqueScopes(sourceEvents.map(({ record }) => captureScope(record)));
    const sourceReadiness = await captureReadiness(sourceScopes, options.destinations, options.readOutcome);
    if (sourceReadiness.status === "dropped") {
        return {
            report: report(turnId, "blocked", "source-dropped", requiredRunIds, sourceReadiness.destinations),
            patches: [],
            captured: 0,
        };
    }
    if (sourceReadiness.status === "pending") {
        return {
            report: report(turnId, "pending", "source-pending", requiredRunIds, sourceReadiness.destinations),
            patches: [],
            captured: 0,
        };
    }
    const runEvents = new Map();
    const recorded = new Map();
    for (const runId of requiredRunIds) {
        const captures = byRunId.get(runId) ?? [];
        runEvents.set(runId, captures);
        recorded.set(runId, recordRun(captures));
    }
    const root = recorded.get(rootRunId);
    const children = requiredRunIds
        .filter((runId) => runId !== rootRunId)
        .map((runId) => recorded.get(runId));
    const turn = {
        path: "",
        origin: "capture",
        root,
        children,
        turnId,
        closed: true,
        delivered: new Set(requiredRunIds),
        fixed: new Set(),
    };
    const attribution = turnAttribution(turn);
    const dependencies = sourceScopes;
    const patches = [];
    let captured = 0;
    for (const runId of requiredRunIds) {
        if (!currentByRunId.has(runId))
            continue;
        const captureEvents = runEvents.get(runId);
        const latest = captureEvents.at(-1);
        const run = recorded.get(runId);
        const merged = attribution === undefined ? undefined : metadataAfterFill(run, attribution);
        const currentAttribution = attributionOf(run.metadata);
        const added = Object.fromEntries(Object.entries(merged === undefined ? {} : (attribution ?? {})).filter(([key]) => currentAttribution[key] === undefined));
        const endTime = retainedEndTime(captureEvents);
        const restoreEndTime = endTime !== undefined &&
            captureEvents.some((event) => (event.metadata.runType === "tool" || event.metadata.runType === "root") &&
                !event.attributionReady &&
                capturedEndTime(event) !== undefined);
        if (Object.keys(added).length === 0 && !restoreEndTime)
            continue;
        const sourceMetadata = mergeMetadataOptions(captureEvents);
        const metadata = Object.keys(added).length === 0 ? sourceMetadata : addAttribution(sourceMetadata, added);
        const updatedMetadata = buildCodingAgentMetadata(metadata);
        if (Object.entries(added).some(([key, value]) => updatedMetadata[key] !== value))
            throw new Error("Settlement metadata could not preserve attribution");
        const submission = patchPayload(latest, metadata, options.integration, restoreEndTime ? endTime : undefined, hasCausalRunError(captureEvents));
        const eventId = settlementEventId(turnId, runId, dependencies, rootRunId, childRunIds, added);
        const scope = {
            integration: options.integration,
            sessionId: options.sessionId,
            turnId,
            eventId,
        };
        const previous = orderSourceCaptures(generated.filter((item) => item.runId === runId && item.eventId !== eventId)).at(-1);
        const previousDependency = previous === undefined ? [] : [captureScope(previous)];
        if (previous !== undefined) {
            const previousReadiness = await captureReadiness(previousDependency, options.destinations, options.readOutcome);
            if (previousReadiness.status === "dropped") {
                return {
                    report: report(turnId, "blocked", "settlement-dropped", [runId], previousReadiness.destinations),
                    patches,
                    captured,
                };
            }
        }
        const result = await options.capture({
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
        });
        if (result.status === "failed" || result.status === "conflict")
            throw new Error(`Could not capture settled run ${runId}: ${result.status}`);
        if (result.status === "published")
            captured += 1;
        patches.push({ turnId, runId, scope });
    }
    const reportResult = report(turnId, patches.length === 0 ? "settled" : "pending", patches.length === 0 ? "no-change" : "settlement-pending", patches.map(({ runId }) => runId));
    return { report: { ...reportResult, patches: patches.length }, patches, captured };
}
//# sourceMappingURL=settle-turn.js.map