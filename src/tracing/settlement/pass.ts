import { createHash } from "node:crypto";
import {
  buildCodingAgentMetadata,
  CODING_AGENT_INTEGRATION_POLICIES,
} from "../../metadata/index.js";
import type { CodingAgentMetadataOptions } from "../../metadata/models.js";
import type {
  CaptureScope,
  JsonValue,
  OutcomeReadResult,
  StoredCapture,
} from "../../storage/capture/models.js";
import {
  canonicalJsonObject,
  canonicalJsonValue,
  ownDataField,
  requireNonBlankString,
  requireOwnDataField,
  requirePlainRecord,
  requireStringArray,
  requireTimestamp,
} from "../../utils/validation/objects.js";
import {
  LIFECYCLE_ATTRIBUTION_READY_FIELD,
  LIFECYCLE_PATCH_EVENT_KIND,
  LIFECYCLE_POST_EVENT_KIND,
  LIFECYCLE_SETTLEMENT_EVENT_KIND,
  LIFECYCLE_TURN_CLOSURE_STATES,
} from "../lifecycle/constants.js";
import { storedAttributionReadiness } from "../lifecycle/closure.js";
import { projectSubmission } from "../lifecycle/projection.js";
import type { ProjectedPayload, ProjectedSubmission } from "../lifecycle/models.js";
import type { PreparedRunPatchSubmission } from "../upload/models.js";
import { SETTLEMENT_EVENT_ID_PREFIX } from "./constants.js";
import { attributionOf, metadataAfterFill, turnAttribution } from "./settlement.js";
import type {
  ProjectedCapture,
  RecordedRun,
  SettlementSourceReadiness,
  TurnSettlementResult,
  SettleCapturedTurnsOptions,
  TurnRecord,
  TurnEvidenceSnapshot,
  TurnSettlementPlannedPatch,
  TurnSettlementProgress,
  TurnSettlementReport,
  TurnSettlementWork,
} from "./models.js";

export async function settleCapturedTurns(
  options: SettleCapturedTurnsOptions,
): Promise<TurnSettlementWork> {
  if (options.destinations.length === 0)
    throw new TypeError("At least one settlement destination is required");
  const sourceRecords = orderSourceCaptures(
    options.captures
      .map(({ record }) => record)
      .filter(
        (record) =>
          record.integration === options.integration &&
          record.sessionId === options.sessionId &&
          record.destinationFingerprint === options.destinationFingerprint &&
          (record.eventKind === LIFECYCLE_POST_EVENT_KIND ||
            record.eventKind === LIFECYCLE_PATCH_EVENT_KIND),
      ),
  );
  const generatedRecords = options.captures
    .map(({ record }) => record)
    .filter(
      (record) =>
        record.integration === options.integration &&
        record.sessionId === options.sessionId &&
        record.destinationFingerprint === options.destinationFingerprint &&
        record.eventKind === LIFECYCLE_SETTLEMENT_EVENT_KIND,
    );
  const projected = new Map<string, ProjectedCapture[]>();
  const allByRunId = new Map<string, ProjectedCapture[]>();
  for (const record of sourceRecords) {
    const capture = projectCapture(record, options.integration);
    if (capture === undefined) continue;
    const turn = projected.get(record.turnId) ?? [];
    turn.push(capture);
    projected.set(record.turnId, turn);
    const runEvents = allByRunId.get(record.runId) ?? [];
    runEvents.push(capture);
    allByRunId.set(record.runId, runEvents);
  }
  const generatedByTurn = groupByTurn(generatedRecords);
  const turns = [...new Set([...projected.keys(), ...generatedByTurn.keys()])].toSorted();
  const reports: TurnSettlementReport[] = [];
  const patches: TurnSettlementPlannedPatch[] = [];
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

export async function refreshSettlementProgress(
  work: TurnSettlementWork,
  destinations: SettleCapturedTurnsOptions["destinations"],
  readOutcome: (scope: CaptureScope, destination: string) => Promise<OutcomeReadResult>,
): Promise<TurnSettlementProgress> {
  const patchesByTurn = new Map<string, TurnSettlementPlannedPatch[]>();
  for (const patch of work.patches) {
    const turn = patchesByTurn.get(patch.turnId) ?? [];
    turn.push(patch);
    patchesByTurn.set(patch.turnId, turn);
  }
  const turns: TurnSettlementReport[] = [];
  for (const entry of work.progress.turns) {
    const patches = patchesByTurn.get(entry.turnId) ?? [];
    if (patches.length === 0 || (entry.status !== "pending" && entry.status !== "settled")) {
      turns.push(entry);
      continue;
    }
    const readiness = await captureReadiness(
      patches.map(({ scope }) => scope),
      destinations,
      readOutcome,
    );
    const { reason: previousReason, destinations: previousDestinations, ...unchanged } = entry;
    const reason =
      readiness.status === "delivered"
        ? previousReason === "settlement-pending"
          ? undefined
          : previousReason
        : readiness.status === "dropped"
          ? "settlement-dropped"
          : "settlement-pending";
    const reportDestinations =
      readiness.destinations.length > 0
        ? readiness.destinations
        : previousReason === "settlement-pending"
          ? undefined
          : previousDestinations;
    turns.push({
      ...unchanged,
      status:
        readiness.status === "dropped"
          ? "blocked"
          : readiness.status === "pending"
            ? "pending"
            : "settled",
      ...(reason === undefined ? {} : { reason }),
      ...(reportDestinations === undefined ? {} : { destinations: reportDestinations }),
    });
  }
  return { captured: work.progress.captured, turns };
}

async function settleOneTurn(
  turnId: string,
  events: ProjectedCapture[],
  generated: StoredCapture[],
  allByRunId: ReadonlyMap<string, ProjectedCapture[]>,
  options: SettleCapturedTurnsOptions,
): Promise<TurnSettlementResult> {
  const rootRunIds = new Set<string>();
  const childRunIds = new Set<string>();
  let closureState: TurnEvidenceSnapshot["closureState"] = "open";
  for (const event of events) {
    const evidence = parseEvidence(event.record.turnEvidence, event.attributionReady);
    if (evidence.rootRunId !== undefined) rootRunIds.add(evidence.rootRunId);
    for (const childRunId of evidence.childRunIds) childRunIds.add(childRunId);
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
  const rootRunId = [...rootRunIds][0]!;
  childRunIds.delete(rootRunId);
  const requiredRunIds = [rootRunId, ...[...childRunIds].toSorted()];
  const currentByRunId = new Map<string, ProjectedCapture[]>();
  for (const event of events) {
    const runEvents = currentByRunId.get(event.record.runId) ?? [];
    runEvents.push(event);
    currentByRunId.set(event.record.runId, runEvents);
  }
  const byRunId = new Map<string, ProjectedCapture[]>();
  for (const runId of requiredRunIds) {
    const runEvents =
      runId === rootRunId ? (currentByRunId.get(runId) ?? []) : (allByRunId.get(runId) ?? []);
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
  const sourceReadiness = await captureReadiness(
    sourceScopes,
    options.destinations,
    options.readOutcome,
  );
  if (sourceReadiness.status === "dropped") {
    return {
      report: report(
        turnId,
        "blocked",
        "source-dropped",
        requiredRunIds,
        sourceReadiness.destinations,
      ),
      patches: [],
      captured: 0,
    };
  }
  if (sourceReadiness.status === "pending") {
    return {
      report: report(
        turnId,
        "pending",
        "source-pending",
        requiredRunIds,
        sourceReadiness.destinations,
      ),
      patches: [],
      captured: 0,
    };
  }
  const runEvents = new Map<string, ProjectedCapture[]>();
  const recorded = new Map<string, RecordedRun>();
  for (const runId of requiredRunIds) {
    const captures = byRunId.get(runId) ?? [];
    runEvents.set(runId, captures);
    recorded.set(runId, recordRun(captures));
  }
  const root = recorded.get(rootRunId)!;
  const children = requiredRunIds
    .filter((runId) => runId !== rootRunId)
    .map((runId) => recorded.get(runId)!);
  const turn: TurnRecord = {
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
  const patches: TurnSettlementPlannedPatch[] = [];
  let captured = 0;
  for (const runId of requiredRunIds) {
    if (!currentByRunId.has(runId)) continue;
    const captureEvents = runEvents.get(runId)!;
    const latest = captureEvents.at(-1)!;
    const run = recorded.get(runId)!;
    const merged = attribution === undefined ? undefined : metadataAfterFill(run, attribution);
    const currentAttribution = attributionOf(run.metadata);
    const added = Object.fromEntries(
      Object.entries(merged === undefined ? {} : (attribution ?? {})).filter(
        ([key]) => currentAttribution[key] === undefined,
      ),
    );
    const endTime = retainedEndTime(captureEvents);
    const restoreEndTime =
      endTime !== undefined &&
      captureEvents.some(
        (event) =>
          (event.metadata.runType === "tool" || event.metadata.runType === "root") &&
          !event.attributionReady &&
          capturedEndTime(event) !== undefined,
      );
    if (Object.keys(added).length === 0 && !restoreEndTime) continue;
    const sourceMetadata = mergeMetadataOptions(captureEvents);
    const metadata =
      Object.keys(added).length === 0 ? sourceMetadata : addAttribution(sourceMetadata, added);
    const updatedMetadata = buildCodingAgentMetadata(metadata);
    if (Object.entries(added).some(([key, value]) => updatedMetadata[key] !== value))
      throw new Error("Settlement metadata could not preserve attribution");
    const submission = patchPayload(
      latest,
      metadata,
      options.integration,
      restoreEndTime ? endTime : undefined,
      hasCausalRunError(captureEvents),
    );
    const eventId = settlementEventId(turnId, runId, dependencies, rootRunId, childRunIds, added);
    const scope: CaptureScope = {
      integration: options.integration,
      sessionId: options.sessionId,
      turnId,
      eventId,
    };
    const previous = orderSourceCaptures(
      generated.filter((item) => item.runId === runId && item.eventId !== eventId),
    ).at(-1);
    const previousDependency = previous === undefined ? [] : [captureScope(previous)];
    if (previous !== undefined) {
      const previousReadiness = await captureReadiness(
        previousDependency,
        options.destinations,
        options.readOutcome,
      );
      if (previousReadiness.status === "dropped") {
        return {
          report: report(
            turnId,
            "blocked",
            "settlement-dropped",
            [runId],
            previousReadiness.destinations,
          ),
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
    if (result.status === "published") captured += 1;
    patches.push({ turnId, runId, scope });
  }
  const reportResult = report(
    turnId,
    patches.length === 0 ? "settled" : "pending",
    patches.length === 0 ? "no-change" : "settlement-pending",
    patches.map(({ runId }) => runId),
  );
  return { report: { ...reportResult, patches: patches.length }, patches, captured };
}

function projectCapture(
  record: StoredCapture,
  integration: SettleCapturedTurnsOptions["integration"],
): ProjectedCapture | undefined {
  const rawPayload = canonicalJsonObject(record.normalizedPayload, "Stored run payload");
  const submission = projectSubmission(
    { ...rawPayload, metadata: record.metadataProvenance },
    integration,
  );
  if (submission.status === "deferred") return undefined;
  const expectedKind =
    submission.value.payload.operation === "post"
      ? LIFECYCLE_POST_EVENT_KIND
      : LIFECYCLE_PATCH_EVENT_KIND;
  if (record.eventKind !== expectedKind)
    throw new TypeError("Capture event kind does not match its operation");
  const evidence = parseEvidence(
    record.turnEvidence,
    storedAttributionReadiness(record, integration),
  );
  return {
    record,
    payload: submission.value.payload,
    metadata: submission.value.metadata,
    open: captureIsOpen(submission.value.payload),
    attributionReady: evidence.attributionReady,
  };
}

function captureIsOpen(payload: ProjectedPayload): boolean {
  if (payload.operation === "post")
    return payload.run.end_time === undefined && payload.run.error === undefined;
  if (payload.privacyContext.status === "running") return true;
  return false;
}

function recordRun(events: ProjectedCapture[]): RecordedRun {
  const latest = events.at(-1)!;
  const run = latest.payload.run;
  return {
    run_id: latest.record.runId,
    ...(run.parent_run_id === undefined ? {} : { parent_run_id: run.parent_run_id }),
    trace_id: requireNonBlankString(run.trace_id, "Trace ID"),
    dotted_order: requireNonBlankString(run.dotted_order, "Dotted order"),
    name: requireNonBlankString(run.name, "Run name"),
    run_type: requireNonBlankString(run.run_type, "Run type"),
    tracing: latest.payload.privacyMode,
    open: latest.open,
    metadata: buildCodingAgentMetadata(mergeMetadataOptions(events)),
  };
}

function mergeMetadataOptions(captures: readonly ProjectedCapture[]): CodingAgentMetadataOptions {
  const first = captures[0];
  if (first === undefined) throw new Error("Run metadata is required for settlement");
  let merged = first.metadata;
  for (const { metadata } of captures.slice(1)) {
    const base = mergeMetadataObject(merged.base, metadata.base);
    const runSpecific = mergeMetadataObject(merged.runSpecific, metadata.runSpecific);
    const providerMetadata = mergeMetadataObject(
      merged.providerMetadata,
      metadata.providerMetadata,
    );
    const usageMetadata = mergeMetadataObject(merged.usageMetadata, metadata.usageMetadata);
    merged = {
      ...merged,
      ...metadata,
      ...(base === undefined ? {} : { base }),
      ...(runSpecific === undefined ? {} : { runSpecific }),
      ...(providerMetadata === undefined ? {} : { providerMetadata }),
      ...(usageMetadata === undefined ? {} : { usageMetadata }),
    };
  }
  return merged;
}

function mergeMetadataObject(
  previous: object | undefined,
  current: object | undefined,
): Record<string, unknown> | undefined {
  if (previous === undefined && current === undefined) return undefined;
  return { ...previous, ...current };
}

function patchPayload(
  source: ProjectedCapture,
  metadata: CodingAgentMetadataOptions,
  integration: SettleCapturedTurnsOptions["integration"],
  endTime?: number | string,
  causalRunError = false,
): ProjectedSubmission {
  const context = source.payload.run;
  const submission: PreparedRunPatchSubmission = {
    operation: "patch",
    integration,
    privacyMode: source.payload.privacyMode,
    ...(source.payload.redactedFields === undefined
      ? {}
      : { redactedFields: source.payload.redactedFields }),
    metadata,
    run: {
      id: context.id,
      name: context.name,
      run_type: context.run_type,
      ...(context.start_time === undefined ? {} : { start_time: context.start_time }),
      ...(context.parent_run_id === undefined ? {} : { parent_run_id: context.parent_run_id }),
      ...(context.trace_id === undefined ? {} : { trace_id: context.trace_id }),
      ...(context.dotted_order === undefined ? {} : { dotted_order: context.dotted_order }),
    },
    privacyContext:
      source.payload.operation === "patch"
        ? {
            ...source.payload.privacyContext,
            ...(causalRunError
              ? { status: "error" as const }
              : endTime !== undefined && source.payload.privacyContext.status !== "error"
                ? { status: "completed" as const }
                : {}),
          }
        : {
            status:
              causalRunError ||
              source.payload.run.error !== undefined ||
              source.payload.privacyContext?.status === "error"
                ? "error"
                : endTime !== undefined || source.payload.run.end_time !== undefined
                  ? "completed"
                  : (source.payload.privacyContext?.status ?? "running"),
          },
    patch:
      endTime === undefined
        ? { fields: [], values: {} }
        : { fields: ["end_time"], values: { end_time: endTime } },
  };
  const projected = projectSubmission(submission, integration);
  if (projected.status === "deferred") throw new Error("Settlement patch lost thread identity");
  return projected.value;
}

function hasCausalRunError(events: readonly ProjectedCapture[]): boolean {
  let hasError = false;
  for (const { payload } of events) {
    if (payload.operation === "post") {
      hasError = payload.run.error !== undefined || payload.privacyContext?.status === "error";
    } else if (payload.patch.fields.includes("error")) {
      hasError = payload.patch.values.error !== undefined;
    } else if (payload.privacyContext.status === "error") {
      hasError = true;
    }
  }
  return hasError;
}

function addAttribution(
  metadata: CodingAgentMetadataOptions,
  attribution: Record<string, string>,
): CodingAgentMetadataOptions {
  const layer =
    CODING_AGENT_INTEGRATION_POLICIES[metadata.integration].fullModePrecedence === "custom-wins"
      ? "base"
      : "runSpecific";
  const previous = metadata[layer] ?? {};
  return { ...metadata, [layer]: { ...previous, ...attribution } };
}

function parseEvidence(value: JsonValue, attributionReady: boolean): TurnEvidenceSnapshot {
  const source = requirePlainRecord(value, "Stored turn evidence");
  const childRunIds = requireStringArray(
    requireOwnDataField(source, "childRunIds"),
    "Child run IDs",
  ).map((runId) => requireNonBlankString(runId, "Child run ID"));
  const closureState = requireOwnDataField(source, "closureState");
  if (
    typeof closureState !== "string" ||
    !LIFECYCLE_TURN_CLOSURE_STATES.includes(closureState as TurnEvidenceSnapshot["closureState"])
  ) {
    throw new TypeError("Stored turn evidence has an invalid closure state");
  }
  const result: TurnEvidenceSnapshot = {
    childRunIds,
    closureState: closureState as TurnEvidenceSnapshot["closureState"],
    attributionReady,
  };
  const rootRunId = ownDataField(source, "rootRunId");
  if (rootRunId.present && rootRunId.value !== undefined)
    result.rootRunId = requireNonBlankString(rootRunId.value, "Root run ID");
  return result;
}

function capturedEndTime(event: ProjectedCapture): number | string | undefined {
  if (event.payload.operation === "post") return event.payload.run.end_time;
  if (!event.payload.patch.fields.includes("end_time")) return undefined;
  const value = event.payload.patch.values.end_time;
  return value === undefined ? undefined : requireTimestamp(value);
}

function retainedEndTime(events: readonly ProjectedCapture[]): number | string | undefined {
  let endTime: number | string | undefined;
  for (const event of events) {
    const captured = capturedEndTime(event);
    if (captured !== undefined) endTime = captured;
  }
  return endTime;
}

function closureRank(state: TurnEvidenceSnapshot["closureState"]): number {
  return state === "authoritative" ? 2 : state === "provisional" ? 1 : 0;
}

async function captureReadiness(
  scopes: readonly CaptureScope[],
  destinations: SettleCapturedTurnsOptions["destinations"],
  readOutcome: SettleCapturedTurnsOptions["readOutcome"],
): Promise<SettlementSourceReadiness> {
  const pending = new Set<string>();
  const dropped = new Set<string>();
  for (const scope of scopes) {
    for (const destination of destinations) {
      const outcome = await readOutcome(scope, destination.id);
      if (outcome.status === "failed")
        throw new Error(`Could not read settlement receipt: ${outcome.code}`);
      if (outcome.status === "settled") {
        if (outcome.receipt.outcome === "dropped") dropped.add(destination.id);
      } else {
        pending.add(destination.id);
      }
    }
  }
  return dropped.size > 0
    ? { status: "dropped", destinations: [...dropped].toSorted() }
    : pending.size > 0
      ? { status: "pending", destinations: [...pending].toSorted() }
      : { status: "delivered", destinations: [] };
}

function settlementEventId(
  turnId: string,
  runId: string,
  dependencies: readonly CaptureScope[],
  rootRunId: string,
  childRunIds: ReadonlySet<string>,
  attribution: Record<string, string>,
): string {
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        turnId,
        runId,
        rootRunId,
        childRunIds: [...childRunIds].toSorted(),
        dependencies: dependencies.toSorted(compareScopes),
        attribution,
      }),
    )
    .digest("hex");
  return `${SETTLEMENT_EVENT_ID_PREFIX}${revision}`;
}

function uniqueScopes(scopes: readonly CaptureScope[]): CaptureScope[] {
  const unique = new Map<string, CaptureScope>();
  for (const scope of scopes) unique.set(JSON.stringify(scope), scope);
  return [...unique.values()].toSorted(compareScopes);
}

function captureScope(record: StoredCapture): CaptureScope {
  return {
    integration: record.integration,
    sessionId: record.sessionId,
    turnId: record.turnId,
    eventId: record.eventId,
  };
}

function captureScopeKey(scope: CaptureScope): string {
  return JSON.stringify([scope.integration, scope.sessionId, scope.turnId, scope.eventId]);
}

function compareScopes(left: CaptureScope, right: CaptureScope): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function compareCaptures(left: StoredCapture, right: StoredCapture): number {
  if (left.capturedAtMs !== right.capturedAtMs) return left.capturedAtMs - right.capturedAtMs;
  return left.eventId.localeCompare(right.eventId);
}

function orderSourceCaptures(records: readonly StoredCapture[]): StoredCapture[] {
  const byScope = new Map(records.map((record) => [captureScopeKey(captureScope(record)), record]));
  const dependents = new Map(
    records.map((record) => [captureScopeKey(captureScope(record)), [] as StoredCapture[]]),
  );
  const dependencyCounts = new Map(
    records.map((record) => [captureScopeKey(captureScope(record)), 0]),
  );
  for (const record of records) {
    const recordKey = captureScopeKey(captureScope(record));
    for (const dependency of record.dependencies ?? []) {
      const prerequisite = byScope.get(captureScopeKey(dependency));
      if (prerequisite === undefined) continue;
      dependents.get(captureScopeKey(captureScope(prerequisite)))!.push(record);
      dependencyCounts.set(recordKey, dependencyCounts.get(recordKey)! + 1);
    }
  }
  const ready: StoredCapture[] = [];
  for (const record of records) {
    if (dependencyCounts.get(captureScopeKey(captureScope(record))) === 0)
      pushOrderedCapture(ready, record);
  }
  const ordered: StoredCapture[] = [];
  while (ready.length > 0) {
    const record = popOrderedCapture(ready)!;
    ordered.push(record);
    for (const dependent of dependents.get(captureScopeKey(captureScope(record))) ?? []) {
      const key = captureScopeKey(captureScope(dependent));
      const count = dependencyCounts.get(key)! - 1;
      dependencyCounts.set(key, count);
      if (count === 0) pushOrderedCapture(ready, dependent);
    }
  }
  if (ordered.length !== records.length)
    throw new TypeError("Source capture dependencies contain a cycle");
  return ordered;
}

function compareSourceCaptures(left: StoredCapture, right: StoredCapture): number {
  return compareCaptures(left, right) || compareScopes(captureScope(left), captureScope(right));
}

function pushOrderedCapture(heap: StoredCapture[], record: StoredCapture): void {
  let index = heap.length;
  heap.push(record);
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const parent = heap[parentIndex]!;
    if (compareSourceCaptures(parent, record) <= 0) break;
    heap[index] = parent;
    index = parentIndex;
  }
  heap[index] = record;
}

function popOrderedCapture(heap: StoredCapture[]): StoredCapture | undefined {
  const first = heap[0];
  if (first === undefined) return undefined;
  const last = heap.pop()!;
  if (heap.length === 0) return first;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    const childIndex =
      rightIndex < heap.length && compareSourceCaptures(heap[rightIndex]!, heap[leftIndex]!) < 0
        ? rightIndex
        : leftIndex;
    const child = heap[childIndex]!;
    if (compareSourceCaptures(last, child) <= 0) break;
    heap[index] = child;
    index = childIndex;
  }
  heap[index] = last;
  return first;
}

function groupByTurn(records: readonly StoredCapture[]): Map<string, StoredCapture[]> {
  const turns = new Map<string, StoredCapture[]>();
  for (const record of records) {
    const captures = turns.get(record.turnId) ?? [];
    captures.push(record);
    turns.set(record.turnId, captures);
  }
  return turns;
}

function report(
  turnId: string,
  status: TurnSettlementReport["status"],
  reason: NonNullable<TurnSettlementReport["reason"]>,
  runIds: string[] = [],
  destinations: string[] = [],
): TurnSettlementReport {
  return {
    turnId,
    status,
    reason,
    ...(runIds.length === 0 ? {} : { runIds }),
    ...(destinations.length === 0 ? {} : { destinations }),
    patches: 0,
  };
}
