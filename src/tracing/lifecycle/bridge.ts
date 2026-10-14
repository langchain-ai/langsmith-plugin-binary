import { join, resolve } from "node:path";
import { tryAcquireFileLock } from "../../storage/index.js";
import { removeEmptyLockFolders } from "../../storage/lock-folders.js";
import { createCaptureStore, removeExpiredCaptures } from "../../storage/capture/index.js";
import { removeStaleStorageFiles } from "../../storage/stale-files.js";
import { STORAGE_STALE_FILE_MAX_AGE_MS } from "../../storage/constants.js";
import { describe } from "../../utils/errors.js";
import type {
  CaptureDestinationRoute,
  CaptureScope,
  JsonValue,
  StoredCapture,
} from "../../storage/capture/models.js";
import { identifierHash } from "../../storage/capture/paths.js";
import { scopeKey, scopeOf } from "../../storage/capture/scope.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import { createDeliveryCoordinator } from "../delivery/index.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import { wakeCapturedWork } from "../capture-wake.js";
import type {
  NormalizedRunContext,
  PreparedRunSubmission,
  UploadBatchItem,
} from "../upload/models.js";
import { refreshSettlementProgress, settleCapturedTurns } from "../settlement/pass.js";
import {
  canonicalJsonObject,
  canonicalJsonValue,
  ownDataField,
  requireNonBlankString,
  requireOwnDataField,
  requirePlainRecord,
  requireSafeEpochMilliseconds,
  requireTimestamp,
} from "../../utils/validation/objects.js";
import { snapshotData } from "../../utils/validation/snapshot.js";
import type {
  CapturedRunsSend,
  LifecycleBridge,
  LifecycleBridgeContext,
  LifecycleBridgeOptions,
  LifecycleCaptureInput,
  LifecycleCaptureRequest,
  LifecycleCaptureResult,
  LifecycleDrainedResult,
  LifecycleDrainInput,
  LifecycleDrainResult,
  LifecycleSettlementPass,
  ProjectedSubmission,
  SuppliedRunIdentity,
} from "./models.js";
import {
  LIFECYCLE_ENGINE_FOLDERS,
  LIFECYCLE_PATCH_EVENT_KIND,
  LIFECYCLE_POST_EVENT_KIND,
  LIFECYCLE_SETTLEMENT_LOCK_ACCOUNTS_DIRECTORY,
  LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY,
  LIFECYCLE_SETTLEMENT_LOCK_FILE,
  LIFECYCLE_SETTLEMENT_LOCK_INTEGRATIONS_DIRECTORY,
  LIFECYCLE_SETTLEMENT_LOCK_SESSIONS_DIRECTORY,
  LIFECYCLE_STORED_CAPTURE_IS_MISSING_THREAD_IDENTITY_MESSAGE,
  LIFECYCLE_STORED_INTEGRATION_DOES_NOT_MATCH_LIFECYCLE_BRIDGE_MESSAGE,
  LIFECYCLE_STORED_PRIVACY_MODE_IS_INVALID_MESSAGE,
  LIFECYCLE_STORED_RUN_CONTEXT_IS_REQUIRED_MESSAGE,
  LIFECYCLE_STORED_RUN_DATA_IS_REQUIRED_MESSAGE,
  LIFECYCLE_STORED_RUN_ID_DOES_NOT_MATCH_ITS_CAPTURE_MESSAGE,
  LIFECYCLE_SWEEP_WARNING,
  LIFECYCLE_UPLOAD_ACCOUNT_CHANGED_MESSAGE,
} from "./constants.js";
import { projectSubmission, projectTurnEvidence } from "./projection.js";
import { removeSettledTurns } from "./turn-removal.js";
import { resolvePolicy } from "../delivery/options.js";
import {
  deriveAttributionReadiness,
  indexCaptureSources,
  withholdUnresolvedEndTime,
} from "./closure.js";

export function createLifecycleBridge(options: LifecycleBridgeOptions): LifecycleBridge {
  const context = createBridgeContext(options);
  return Object.freeze({
    accountFingerprint: context.writer.accountFingerprint,
    capture: (input: LifecycleCaptureInput) => captureLifecycleSubmission(context, input),
    drain: (input: LifecycleDrainInput = {}) => drainLifecycleWork(context, input),
  });
}

function createBridgeContext(options: LifecycleBridgeOptions): LifecycleBridgeContext {
  const integration = options.integration;
  const sessionId = requireNonBlankString(options.sessionId, "Session ID");
  const storageRoot = resolve(options.storageRoot);
  const captureStore = createCaptureStore(storageRoot);
  const coordinator = createDeliveryCoordinator({
    storageRoot,
    integration,
    sessionId,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  const writer = createLangSmithUploadWriter(options.writer);
  const policy = resolvePolicy(options.policy);
  return {
    integration,
    sessionId,
    storageRoot,
    captureStore,
    coordinator,
    writer,
    policy,
    wake: options.wake,
  };
}

function parseCaptureRequest(input: LifecycleCaptureInput): LifecycleCaptureRequest {
  const record = requirePlainRecord(
    snapshotData(requirePlainRecord(input, "Lifecycle capture")),
    "Lifecycle capture",
  );
  const turnId = requireNonBlankString(record["turnId"], "Turn ID");
  const eventId = requireNonBlankString(record["eventId"], "Event ID");
  const sourceAge = ownDataField(record, "sourceAgeStartedAtMs");
  const sourceAgeStartedAtMs = sourceAge.present
    ? requireSafeEpochMilliseconds(sourceAge.value, "Source age")
    : undefined;
  return { record, turnId, eventId, sourceAgeStartedAtMs };
}

async function parentPostDependency(
  context: LifecycleBridgeContext,
  value: ProjectedSubmission,
): Promise<CaptureScope[]> {
  const parentRunId = value.payload.run.parent_run_id;
  if (value.payload.operation !== "post" || parentRunId === undefined) return [];
  const captures = await context.captureStore.enumerate(context.integration, context.sessionId);
  const parent = captures.find(
    ({ record }) => record.runId === parentRunId && record.eventKind === LIFECYCLE_POST_EVENT_KIND,
  );
  return parent === undefined ? [] : [scopeOf(parent.record)];
}

async function captureDependencies(
  context: LifecycleBridgeContext,
  request: LifecycleCaptureRequest,
  value: ProjectedSubmission,
): Promise<LifecycleCaptureInput["dependencies"]> {
  const supplied = request.record["dependencies"] as LifecycleCaptureInput["dependencies"];
  const previous = await context.captureStore.read({
    integration: context.integration,
    sessionId: context.sessionId,
    turnId: request.turnId,
    eventId: request.eventId,
  });
  const suppliedKeys = new Set((supplied ?? []).map(scopeKey));
  if (previous?.dependencies?.some((scope) => !suppliedKeys.has(scopeKey(scope))))
    return previous.dependencies;
  if (previous !== undefined) return supplied;
  const parent = (await parentPostDependency(context, value)).filter(
    (scope) => !suppliedKeys.has(scopeKey(scope)),
  );
  return parent.length === 0 ? supplied : [...(supplied ?? []), ...parent];
}

async function saveProjectedSubmission(
  context: LifecycleBridgeContext,
  request: LifecycleCaptureRequest,
  turnEvidence: JsonValue,
  value: ProjectedSubmission,
) {
  const dependencies = await captureDependencies(context, request, value);
  return context.coordinator.capture({
    turnId: request.turnId,
    eventId: request.eventId,
    runId: value.payload.run.id,
    destinationFingerprint: context.writer.accountFingerprint,
    eventKind:
      value.payload.operation === "post" ? LIFECYCLE_POST_EVENT_KIND : LIFECYCLE_PATCH_EVENT_KIND,
    normalizedPayload: canonicalJsonValue(value.payload),
    turnEvidence,
    metadataProvenance: canonicalJsonValue(value.metadata),
    ...(request.sourceAgeStartedAtMs === undefined
      ? {}
      : { sourceAgeStartedAtMs: request.sourceAgeStartedAtMs }),
    ...(dependencies === undefined ? {} : { dependencies }),
    destinationRoutes: context.writer.routes,
  });
}

async function retryWithoutSuppliedIdentity(
  context: LifecycleBridgeContext,
  request: LifecycleCaptureRequest,
  scope: CaptureScope,
  turnEvidence: JsonValue,
  projected: ProjectedSubmission,
  identityPresence: SuppliedRunIdentity,
): Promise<LifecycleCaptureResult | undefined> {
  const winner = await context.captureStore.read(scope);
  if (winner?.runId !== projected.payload.run.id) return undefined;
  const run = { ...projected.payload.run };
  if (!identityPresence.startTime) delete run.start_time;
  if (!identityPresence.traceId) delete run.trace_id;
  if (!identityPresence.dottedOrder) delete run.dotted_order;
  const retry = projectSubmission(
    { ...projected.payload, run, metadata: projected.metadata },
    context.integration,
    previousRunContext(winner),
  );
  if (retry.status !== "ready") return undefined;
  return saveProjectedSubmission(context, request, turnEvidence, retry.value);
}

async function captureLifecycleSubmission(
  context: LifecycleBridgeContext,
  input: LifecycleCaptureInput,
): Promise<LifecycleCaptureResult> {
  const request = parseCaptureRequest(input);
  const scope: CaptureScope = {
    integration: context.integration,
    sessionId: context.sessionId,
    turnId: request.turnId,
    eventId: request.eventId,
  };
  const previous = await context.captureStore.read(scope);
  const projected = projectSubmission(
    request.record["submission"],
    context.integration,
    previous === undefined ? undefined : previousRunContext(previous),
  );
  if (projected.status === "deferred") {
    return { status: "deferred", reason: "missing-thread-identity" };
  }
  const turnEvidence = projectTurnEvidence(
    request.record["turnEvidence"],
    projected.value.payload.privacyMode,
    deriveAttributionReadiness(request.record["submission"], context.integration),
  );
  const identityPresence =
    projected.value.payload.operation === "post"
      ? suppliedRunIdentityFields(request.record["submission"])
      : undefined;
  let result: LifecycleCaptureResult = await saveProjectedSubmission(
    context,
    request,
    turnEvidence,
    projected.value,
  );
  if (
    result.status === "conflict" &&
    previous === undefined &&
    identityPresence !== undefined &&
    projected.value.payload.operation === "post"
  ) {
    result =
      (await retryWithoutSuppliedIdentity(
        context,
        request,
        scope,
        turnEvidence,
        projected.value,
        identityPresence,
      )) ?? result;
  }
  if (result.status === "published" || result.status === "duplicate")
    await wakeCapturedWork(result, () => context.wake?.());
  return result;
}

function busyDrainResult() {
  return { status: "busy" as const, settlement: { captured: 0, turns: [] } };
}

async function acquireSettlementLock(context: LifecycleBridgeContext) {
  const directory = await ensurePrivateDirectory(context.storageRoot, [
    LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY,
    LIFECYCLE_SETTLEMENT_LOCK_INTEGRATIONS_DIRECTORY,
    context.integration,
    LIFECYCLE_SETTLEMENT_LOCK_SESSIONS_DIRECTORY,
    identifierHash(context.sessionId),
    LIFECYCLE_SETTLEMENT_LOCK_ACCOUNTS_DIRECTORY,
    identifierHash(context.writer.accountFingerprint),
  ]);
  const path = join(directory, LIFECYCLE_SETTLEMENT_LOCK_FILE);
  return { path, lock: await tryAcquireFileLock(path) };
}

async function sweepWithWarning<T>(fallback: T, sweep: () => Promise<T>): Promise<T> {
  try {
    return await sweep();
  } catch (error) {
    console.warn(LIFECYCLE_SWEEP_WARNING, describe(error));
    return fallback;
  }
}

function sweepExpiredCaptures(context: LifecycleBridgeContext, now: number): Promise<number> {
  return sweepWithWarning(0, () =>
    removeExpiredCaptures({
      store: context.captureStore,
      integration: context.integration,
      destinations: context.writer.destinations.map(({ id }) => id),
      accountFingerprint: context.writer.accountFingerprint,
      now,
      maxAgeMs: context.policy.maxAgeMs,
    }),
  );
}

function sweepStaleFiles(context: LifecycleBridgeContext, now: number): Promise<number> {
  return sweepWithWarning(0, () =>
    removeStaleStorageFiles(
      context.storageRoot,
      LIFECYCLE_ENGINE_FOLDERS,
      now - STORAGE_STALE_FILE_MAX_AGE_MS,
    ),
  );
}

function readCaptureOutcome(context: LifecycleBridgeContext) {
  return (scope: CaptureScope, destination: string) =>
    context.captureStore.readOutcome(scope, destination);
}

async function sendCapturedRuns(context: LifecycleBridgeContext, send: CapturedRunsSend) {
  const { sourceSnapshot, sourceByScope, records, destination, fingerprint } = send;
  const { integration, writer } = context;
  if (fingerprint !== writer.accountFingerprint)
    throw new Error(LIFECYCLE_UPLOAD_ACCOUNT_CHANGED_MESSAGE);
  const items: UploadBatchItem[] = [];
  for (const record of records) {
    const submission = restoreSubmission(record, integration);
    const outgoing = await withholdUnresolvedEndTime({
      record,
      submission,
      sourceSnapshot,
      sourceByScope,
      integration,
      destinations: writer.destinations,
      readOutcome: readCaptureOutcome(context),
    });
    const route = capturedRoute(record, sourceSnapshot, destination.id);
    items.push(route === undefined ? { submission: outgoing } : { submission: outgoing, route });
  }
  await writer.sendBatch(items, destination.id);
}

async function drainOnce(context: LifecycleBridgeContext, attempted: Set<string>) {
  const { captureStore, integration, sessionId, writer } = context;
  const sourceSnapshot = (await captureStore.enumerate(integration, sessionId)).map(
    ({ record }) => record,
  );
  const sourceByScope = indexCaptureSources(sourceSnapshot);
  return context.coordinator.drain({
    writer: {
      accountFingerprint: writer.accountFingerprint,
      destinations: writer.destinations,
      sendBatch: (records, destination, fingerprint) =>
        sendCapturedRuns(context, {
          sourceSnapshot,
          sourceByScope,
          records,
          destination,
          fingerprint,
        }),
      batchLimits: {
        maxRecords: writer.batchLimits.maxRuns,
        maxBytes: writer.batchLimits.maxBytes,
      },
    },
    attempted,
  });
}

async function settleSessionTurns(
  context: LifecycleBridgeContext,
): Promise<LifecycleSettlementPass> {
  const { captureStore, coordinator, integration, sessionId, writer } = context;
  const captures = await captureStore.enumerate(integration, sessionId);
  const work = await settleCapturedTurns({
    captures,
    integration,
    sessionId,
    destinationFingerprint: writer.accountFingerprint,
    destinations: writer.destinations,
    capture: (captureInput) => coordinator.capture(captureInput),
    readOutcome: readCaptureOutcome(context),
    droppedRunIds: (turnId) => captureStore.readDroppedRunIds(integration, sessionId, turnId),
    settledTurn: (turnId) => captureStore.readSettledTurn(integration, sessionId, turnId),
  });
  return { captures, work };
}

function mergeDrainResults(
  first: LifecycleDrainedResult,
  second: LifecycleDrainedResult,
): LifecycleDrainedResult {
  return {
    status: "drained",
    delivered: first.delivered + second.delivered,
    dropped: first.dropped + second.dropped,
    failed: first.failed + second.failed,
    pending: second.pending,
    ...(second.nextRetryAtMs === undefined ? {} : { nextRetryAtMs: second.nextRetryAtMs }),
    accountMismatch: second.accountMismatch,
  };
}

async function drainWhileLocked(
  context: LifecycleBridgeContext,
  input: LifecycleDrainInput,
): Promise<LifecycleDrainResult> {
  const { captureStore, integration, sessionId, writer } = context;
  const attempted = new Set<string>();
  const now = input.now ?? Date.now();
  const expired = await sweepExpiredCaptures(context, now);
  await sweepStaleFiles(context, now);
  const first = await drainOnce(context, attempted);
  if (first.status === "busy") return busyDrainResult();
  const { captures, work } = await settleSessionTurns(context);
  let result = first;
  if (work.progress.captured > 0) {
    const second = await drainOnce(context, attempted);
    if (second.status === "drained") result = mergeDrainResults(first, second);
  }
  const readOutcome = readCaptureOutcome(context);
  const settlement = await refreshSettlementProgress(work, writer.destinations, readOutcome);
  await removeSettledTurns({
    integration,
    sessionId,
    destinationFingerprint: writer.accountFingerprint,
    store: captureStore,
    destinations: writer.destinations,
    settledTurnIds: settlement.turns
      .filter((entry) => entry.status === "settled")
      .map((entry) => entry.turnId),
    settledTurns: new Map(
      settlement.turns.flatMap((entry) =>
        entry.settled === undefined ? [] : [[entry.turnId, entry.settled] as const],
      ),
    ),
    knownScopes: [
      ...captures.map(({ record }) => record),
      ...work.patches.map(({ scope }) => scope),
    ],
  });
  return { ...result, dropped: result.dropped + expired, settlement };
}

async function drainLifecycleWork(
  context: LifecycleBridgeContext,
  input: LifecycleDrainInput,
): Promise<LifecycleDrainResult> {
  const { path, lock } = await acquireSettlementLock(context);
  if (lock === undefined) return busyDrainResult();
  let drainResult: LifecycleDrainResult;
  try {
    drainResult = await drainWhileLocked(context, input);
  } finally {
    await lock.release();
    await removeEmptyLockFolders(path, context.storageRoot);
  }
  if (drainResult.status === "drained" && drainResult.delivered + drainResult.dropped > 0) {
    await context.wake?.();
  }
  return drainResult;
}

function capturedRoute(
  record: StoredCapture,
  sourceSnapshot: StoredCapture[],
  destination: string,
): CaptureDestinationRoute | undefined {
  return (
    record.destinationRoutes?.[destination] ??
    sourceSnapshot.find(
      (source) =>
        source.runId === record.runId && source.destinationRoutes?.[destination] !== undefined,
    )?.destinationRoutes?.[destination]
  );
}

function suppliedRunIdentityFields(value: unknown): SuppliedRunIdentity {
  const source = requirePlainRecord(value, "Prepared run submission");
  const run = requirePlainRecord(requireOwnDataField(source, "run"), "Normalized run snapshot");
  const supplied = (key: string) => {
    const field = ownDataField(run, key);
    return field.present && field.value !== undefined;
  };
  return {
    startTime: supplied("start_time"),
    traceId: supplied("trace_id"),
    dottedOrder: supplied("dotted_order"),
  };
}

function previousRunContext(record: StoredCapture): NormalizedRunContext {
  const payload = requirePlainRecord(record.normalizedPayload, "Stored run payload");
  const runField = ownDataField(payload, "run");
  if (!runField.present) throw new TypeError(LIFECYCLE_STORED_RUN_CONTEXT_IS_REQUIRED_MESSAGE);
  const run = requirePlainRecord(runField.value, "Stored run context");
  const context: NormalizedRunContext = {
    id: requireNonBlankString(run["id"], "Run ID"),
    name: requireNonBlankString(run["name"], "Run name"),
    run_type: requireNonBlankString(run["run_type"], "Run type"),
  };
  const startTime = ownDataField(run, "start_time");
  if (startTime.present && startTime.value !== undefined)
    context.start_time = requireTimestamp(startTime.value);
  const parentRunId = ownDataField(run, "parent_run_id");
  if (parentRunId.present && parentRunId.value !== undefined) {
    context.parent_run_id = requireNonBlankString(parentRunId.value, "Parent run ID");
  }
  const traceId = ownDataField(run, "trace_id");
  if (traceId.present && traceId.value !== undefined) {
    context.trace_id = requireNonBlankString(traceId.value, "Trace ID");
  }
  const dottedOrder = ownDataField(run, "dotted_order");
  if (dottedOrder.present && dottedOrder.value !== undefined) {
    context.dotted_order = requireNonBlankString(dottedOrder.value, "Dotted order");
  }
  return context;
}

function restoreSubmission(
  record: StoredCapture,
  integration: LifecycleBridgeOptions["integration"],
): PreparedRunSubmission {
  const payload = canonicalJsonObject(record.normalizedPayload, "Stored run payload");
  if (payload["integration"] !== integration)
    throw new TypeError(LIFECYCLE_STORED_INTEGRATION_DOES_NOT_MATCH_LIFECYCLE_BRIDGE_MESSAGE);
  if (payload["run"] === null || typeof payload["run"] !== "object") {
    throw new TypeError(LIFECYCLE_STORED_RUN_DATA_IS_REQUIRED_MESSAGE);
  }
  const run = payload["run"] as Record<string, unknown>;
  if (run["id"] !== record.runId)
    throw new TypeError(LIFECYCLE_STORED_RUN_ID_DOES_NOT_MATCH_ITS_CAPTURE_MESSAGE);
  const mode = payload["privacyMode"];
  if (mode !== "full" && mode !== "metadata")
    throw new TypeError(LIFECYCLE_STORED_PRIVACY_MODE_IS_INVALID_MESSAGE);
  const projected = projectSubmission(
    { ...payload, metadata: record.metadataProvenance },
    integration,
  );
  if (projected.status === "deferred")
    throw new TypeError(LIFECYCLE_STORED_CAPTURE_IS_MISSING_THREAD_IDENTITY_MESSAGE);
  return { ...projected.value.payload, metadata: projected.value.metadata };
}
