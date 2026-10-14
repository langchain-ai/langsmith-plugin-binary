import { buildCodingAgentMetadata } from "../../metadata/index.js";
import { canonicalJsonValue } from "../../utils/validation/objects.js";
import type { CaptureScope, StoredCapture } from "../../storage/capture/models.js";
import {
  LIFECYCLE_ATTRIBUTION_READY_FIELD,
  LIFECYCLE_SETTLEMENT_EVENT_KIND,
} from "../lifecycle/constants.js";
import { captureReadiness } from "./readiness.js";
import { recordRun, mergeMetadataOptions } from "./recorded-run.js";
import { settlementEventId } from "./revision.js";
import { capturedEndTime, hasCausalRunError, retainedEndTime } from "./run-state.js";
import { attributionOf, metadataAfterFill, turnAttribution } from "./settlement.js";
import { captureScope, orderSourceCaptures, report, uniqueScopes } from "./source-order.js";
import { addAttribution, closureRank, parseEvidence, patchPayload } from "./projection.js";
import type {
  ProjectedCapture,
  RecordedRun,
  RunSettlementAttempt,
  SettleCapturedTurnsOptions,
  TurnEvidenceCollection,
  TurnEvidenceSnapshot,
  TurnRecord,
  TurnSettlementContext,
  TurnSettlementPlannedPatch,
  TurnSettlementResult,
  UnsettledSourceReadiness,
} from "./models.js";

export async function settleOneTurn(
  turnId: string,
  events: ProjectedCapture[],
  generated: StoredCapture[],
  allByRunId: ReadonlyMap<string, ProjectedCapture[]>,
  options: SettleCapturedTurnsOptions,
): Promise<TurnSettlementResult> {
  const evidence = collectTurnEvidence(events);
  if (evidence.rootRunIds.size === 0) {
    return emptyTurnResult(report(turnId, "deferred", "missing-root"));
  }
  if (evidence.rootRunIds.size > 1) {
    return emptyTurnResult(
      report(turnId, "blocked", "conflicting-root", [...evidence.rootRunIds].toSorted()),
    );
  }
  if (evidence.closureState !== "authoritative") {
    return emptyTurnResult(report(turnId, "deferred", evidence.closureState));
  }

  const rootRunId = [...evidence.rootRunIds][0]!;
  const childRunIds = new Set(evidence.childRunIds);
  childRunIds.delete(rootRunId);
  const requiredRunIds = [rootRunId, ...[...childRunIds].toSorted()];
  const currentByRunId = new Map<string, ProjectedCapture[]>();
  for (const event of events) {
    const runEvents = currentByRunId.get(event.record.runId) ?? [];
    runEvents.push(event);
    currentByRunId.set(event.record.runId, runEvents);
  }
  const runEventsById = new Map<string, ProjectedCapture[]>();
  for (const runId of requiredRunIds) {
    const runEvents =
      runId === rootRunId ? (currentByRunId.get(runId) ?? []) : (allByRunId.get(runId) ?? []);
    if (!runEvents.some(({ payload }) => payload.operation === "post")) {
      return emptyTurnResult(report(turnId, "deferred", "missing-run", [runId]));
    }
    runEventsById.set(runId, runEvents);
  }

  const sourceEvents = [...events];
  for (const childRunId of childRunIds) {
    sourceEvents.push(...(allByRunId.get(childRunId) ?? []));
  }
  const sourceScopes = uniqueScopes(sourceEvents.map(({ record }) => captureScope(record)));
  const sourceReadiness = await captureReadiness(
    sourceScopes,
    options.destinations,
    options.readOutcome,
  );
  if (sourceReadiness.status !== "delivered") {
    return sourceReadinessResult(turnId, requiredRunIds, sourceReadiness);
  }

  const recordedByRunId = new Map<string, RecordedRun>();
  for (const runId of requiredRunIds) {
    recordedByRunId.set(runId, recordRun(runEventsById.get(runId) ?? []));
  }
  const turn = buildTurnRecord(turnId, rootRunId, requiredRunIds, recordedByRunId);
  const context: TurnSettlementContext = {
    turnId,
    rootRunId,
    childRunIds,
    closureState: evidence.closureState,
    dependencies: sourceScopes,
    currentByRunId,
    runEventsById,
    recordedByRunId,
    attribution: turnAttribution(turn),
    generated,
    options,
  };

  const patches: TurnSettlementPlannedPatch[] = [];
  let captured = 0;
  for (const runId of requiredRunIds) {
    const attempt = await settleRun(runId, context);
    if (attempt.status === "blocked") {
      return {
        report: report(turnId, "blocked", "settlement-dropped", [runId], attempt.destinations),
        patches,
        captured,
      };
    }
    if (attempt.status === "captured") {
      patches.push(attempt.patch);
      captured += attempt.captured;
    }
  }

  const status = patches.length === 0 ? "settled" : "pending";
  const reason = patches.length === 0 ? "no-change" : "settlement-pending";
  const turnReport = report(
    turnId,
    status,
    reason,
    patches.map(({ runId }) => runId),
  );
  return { report: { ...turnReport, patches: patches.length }, patches, captured };
}

function collectTurnEvidence(events: readonly ProjectedCapture[]): TurnEvidenceCollection {
  const rootRunIds = new Set<string>();
  const childRunIds = new Set<string>();
  let closureState: TurnEvidenceSnapshot["closureState"] = "open";
  for (const event of events) {
    const evidence = parseEvidence(event.record.turnEvidence, event.attributionReady);
    if (evidence.rootRunId !== undefined) rootRunIds.add(evidence.rootRunId);
    for (const childRunId of evidence.childRunIds) childRunIds.add(childRunId);
    if (closureRank(evidence.closureState) > closureRank(closureState)) {
      closureState = evidence.closureState;
    }
  }
  return { rootRunIds, childRunIds, closureState };
}

function emptyTurnResult(turnReport: TurnSettlementResult["report"]): TurnSettlementResult {
  return { report: turnReport, patches: [], captured: 0 };
}

function sourceReadinessResult(
  turnId: string,
  requiredRunIds: readonly string[],
  readiness: UnsettledSourceReadiness,
): TurnSettlementResult {
  const status = readiness.status === "dropped" ? "blocked" : "pending";
  const reason = readiness.status === "dropped" ? "source-dropped" : "source-pending";
  return emptyTurnResult(
    report(turnId, status, reason, [...requiredRunIds], readiness.destinations),
  );
}

function buildTurnRecord(
  turnId: string,
  rootRunId: string,
  requiredRunIds: readonly string[],
  recordedByRunId: ReadonlyMap<string, RecordedRun>,
): TurnRecord {
  const root = recordedByRunId.get(rootRunId)!;
  const children = requiredRunIds
    .filter((runId) => runId !== rootRunId)
    .map((runId) => recordedByRunId.get(runId)!);
  return {
    path: "",
    origin: "capture",
    root,
    children,
    turnId,
    closed: true,
    delivered: new Set(requiredRunIds),
    fixed: new Set(),
  };
}

async function settleRun(
  runId: string,
  context: TurnSettlementContext,
): Promise<RunSettlementAttempt> {
  if (!context.currentByRunId.has(runId)) return { status: "unchanged" };
  const captureEvents = context.runEventsById.get(runId)!;
  const latest = captureEvents.at(-1)!;
  const run = context.recordedByRunId.get(runId)!;
  const added = attributionToAdd(run, context.attribution);
  const endTime = retainedEndTime(captureEvents);
  const restoreEndTime =
    endTime !== undefined &&
    captureEvents.some(
      (event) =>
        (event.metadata.runType === "tool" || event.metadata.runType === "root") &&
        !event.attributionReady &&
        capturedEndTime(event) !== undefined,
    );
  if (Object.keys(added).length === 0 && !restoreEndTime) return { status: "unchanged" };

  const metadata = settlementMetadata(captureEvents, added);
  const submission = patchPayload(
    latest,
    metadata,
    context.options.integration,
    restoreEndTime ? endTime : undefined,
    hasCausalRunError(captureEvents),
  );
  const eventId = settlementEventId(
    context.turnId,
    runId,
    context.dependencies,
    context.rootRunId,
    context.childRunIds,
    added,
  );
  const scope: CaptureScope = {
    integration: context.options.integration,
    sessionId: context.options.sessionId,
    turnId: context.turnId,
    eventId,
  };
  const previous = orderSourceCaptures(
    context.generated.filter((item) => item.runId === runId && item.eventId !== eventId),
  ).at(-1);
  const previousDependency = previous === undefined ? [] : [captureScope(previous)];
  if (previous !== undefined) {
    const previousReadiness = await captureReadiness(
      previousDependency,
      context.options.destinations,
      context.options.readOutcome,
    );
    if (previousReadiness.status === "dropped") {
      return { status: "blocked", destinations: previousReadiness.destinations };
    }
  }

  const result = await context.options.capture({
    turnId: context.turnId,
    eventId,
    runId,
    destinationFingerprint: context.options.destinationFingerprint,
    eventKind: LIFECYCLE_SETTLEMENT_EVENT_KIND,
    normalizedPayload: canonicalJsonValue(submission.payload),
    metadataProvenance: canonicalJsonValue(submission.metadata),
    turnEvidence: canonicalJsonValue({
      rootRunId: context.rootRunId,
      childRunIds: [...context.childRunIds].toSorted(),
      closureState: context.closureState,
      [LIFECYCLE_ATTRIBUTION_READY_FIELD]: latest.attributionReady,
    }),
    dependencies: uniqueScopes([...context.dependencies, ...previousDependency]),
  });
  if (result.status === "failed" || result.status === "conflict") {
    throw new Error(`Could not capture settled run ${runId}: ${result.status}`);
  }
  return {
    status: "captured",
    patch: { turnId: context.turnId, runId, scope },
    captured: result.status === "published" ? 1 : 0,
  };
}

function attributionToAdd(
  run: RecordedRun,
  attribution: TurnSettlementContext["attribution"],
): Record<string, string> {
  if (attribution === undefined || metadataAfterFill(run, attribution) === undefined) return {};
  const existing = attributionOf(run.metadata);
  return Object.fromEntries(
    Object.entries(attribution).filter(([key]) => existing[key] === undefined),
  );
}

function settlementMetadata(
  events: readonly ProjectedCapture[],
  added: Record<string, string>,
): ReturnType<typeof mergeMetadataOptions> {
  const sourceMetadata = mergeMetadataOptions(events);
  const metadata =
    Object.keys(added).length === 0 ? sourceMetadata : addAttribution(sourceMetadata, added);
  const updated = buildCodingAgentMetadata(metadata);
  if (Object.entries(added).some(([key, value]) => updated[key] !== value)) {
    throw new Error("Settlement metadata could not preserve attribution");
  }
  return metadata;
}
