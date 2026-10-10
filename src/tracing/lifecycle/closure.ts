import {
  buildCodingAgentMetadata,
  prepareCodingAgentMetadataProvenance,
} from "../../metadata/index.js";
import type { CodingAgentIntegration } from "../../metadata/models.js";
import type {
  CaptureScope,
  OutcomeReadResult,
  StoredCapture,
} from "../../storage/capture/models.js";
import {
  ownDataField,
  requireBoolean,
  requireNonBlankString,
  requireOwnDataField,
  requirePlainRecord,
  requireStringArray,
} from "../../utils/validation/objects.js";
import type { DeliveryDestination } from "../delivery/models.js";
import type { PreparedRunSubmission } from "../upload/models.js";
import {
  LIFECYCLE_ATTRIBUTION_READY_FIELD,
  LIFECYCLE_PATCH_EVENT_KIND,
  LIFECYCLE_POST_EVENT_KIND,
  LIFECYCLE_TURN_CLOSURE_STATES,
} from "./constants.js";
import type { LifecycleEndTimeWithholdingInput } from "./models.js";

export function deriveAttributionReadiness(
  value: unknown,
  integration: CodingAgentIntegration,
): boolean {
  const source = requirePlainRecord(value, "Prepared run submission");
  const metadata = prepareCodingAgentMetadataProvenance(
    requireOwnDataField(source, "metadata"),
    integration,
    "full",
  );
  if (metadata.status === "deferred") return false;
  return attributionMetadataReady(buildCodingAgentMetadata(metadata.value));
}

export function storedAttributionReadiness(
  record: StoredCapture,
  integration: CodingAgentIntegration,
): boolean {
  const evidence = requirePlainRecord(record.turnEvidence, "Stored turn evidence");
  const readiness = ownDataField(evidence, LIFECYCLE_ATTRIBUTION_READY_FIELD);
  if (readiness.present) {
    return requireBoolean(
      readiness.value,
      `Stored turn evidence ${LIFECYCLE_ATTRIBUTION_READY_FIELD}`,
    );
  }
  const payload = requirePlainRecord(record.normalizedPayload, "Stored run payload");
  if (requireOwnDataField(payload, "privacyMode") !== "full") return false;
  const metadata = prepareCodingAgentMetadataProvenance(
    record.metadataProvenance,
    integration,
    "full",
  );
  if (metadata.status === "deferred") return false;
  return attributionMetadataReady(buildCodingAgentMetadata(metadata.value));
}

export function indexCaptureSources(
  sources: readonly StoredCapture[],
): ReadonlyMap<string, StoredCapture> {
  return new Map(sources.map((source) => [captureScopeKey(captureScope(source)), source]));
}

function attributionMetadataReady(projected: Record<string, unknown>): boolean {
  return (
    typeof projected["repository_name"] === "string" &&
    projected["repository_name"].length > 0 &&
    typeof projected["ls_attribution_identifier"] === "string" &&
    projected["ls_attribution_identifier"].length > 0
  );
}

export async function withholdUnresolvedEndTime(
  input: LifecycleEndTimeWithholdingInput,
): Promise<PreparedRunSubmission> {
  const {
    record,
    submission,
    sourceSnapshot,
    sourceByScope,
    integration,
    destinations,
    readOutcome,
  } = input;
  if (
    record.eventKind !== LIFECYCLE_POST_EVENT_KIND &&
    record.eventKind !== LIFECYCLE_PATCH_EVENT_KIND
  ) {
    return submission;
  }
  const evidence = requirePlainRecord(record.turnEvidence, "Stored turn evidence");
  const attributionReady = storedAttributionReadiness(record, integration);
  const closureState = requireOwnDataField(evidence, "closureState");
  if (
    typeof closureState !== "string" ||
    !LIFECYCLE_TURN_CLOSURE_STATES.includes(
      closureState as "open" | "provisional" | "authoritative",
    )
  ) {
    throw new TypeError("Stored turn evidence has an invalid closure state");
  }
  const runType = submission.metadata.runType;
  if (runType !== "tool" && runType !== "root") return submission;
  const hasCurrentEndTime =
    submission.operation === "post"
      ? submission.run.end_time !== undefined
      : submission.patch.fields.includes("end_time");
  const hasEndTime = hasCurrentEndTime || hasPriorEndTime(record, sourceByScope);
  if (!hasEndTime || attributionReady) return submission;
  if (
    runType === "root" &&
    !(await hasMissingChildReceipts(record, evidence, sourceSnapshot, destinations, readOutcome))
  ) {
    return submission;
  }
  return removeOutgoingEndTime(submission);
}

function hasPriorEndTime(
  record: StoredCapture,
  sourceByScope: ReadonlyMap<string, StoredCapture>,
): boolean {
  const pending = [...(record.dependencies ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const scope = pending.pop()!;
    const key = captureScopeKey(scope);
    if (visited.has(key)) continue;
    visited.add(key);
    const previous = sourceByScope.get(key);
    if (previous === undefined) continue;
    if (
      previous.runId === record.runId &&
      (previous.eventKind === LIFECYCLE_POST_EVENT_KIND ||
        previous.eventKind === LIFECYCLE_PATCH_EVENT_KIND) &&
      recordHasEndTime(previous)
    ) {
      return true;
    }
    pending.push(...(previous.dependencies ?? []));
  }
  return false;
}

function recordHasEndTime(record: StoredCapture): boolean {
  const payload = requirePlainRecord(record.normalizedPayload, "Stored run payload");
  if (payload["operation"] === "post") {
    const run = requirePlainRecord(requireOwnDataField(payload, "run"), "Stored run snapshot");
    const endTime = ownDataField(run, "end_time");
    return endTime.present && endTime.value !== undefined;
  }
  if (payload["operation"] !== "patch") return false;
  const patch = requirePlainRecord(requireOwnDataField(payload, "patch"), "Stored run patch");
  const fields = requireStringArray(requireOwnDataField(patch, "fields"), "Patch fields");
  if (!fields.includes("end_time")) return false;
  const values = requirePlainRecord(requireOwnDataField(patch, "values"), "Patch values");
  const endTime = ownDataField(values, "end_time");
  return endTime.present && endTime.value !== undefined;
}

async function hasMissingChildReceipts(
  record: StoredCapture,
  evidence: Record<string, unknown>,
  sourceSnapshot: readonly StoredCapture[],
  destinations: readonly DeliveryDestination[],
  readOutcome: (scope: CaptureScope, destination: string) => Promise<OutcomeReadResult>,
): Promise<boolean> {
  const childRunIds = requireStringArray(
    requireOwnDataField(evidence, "childRunIds"),
    "Child run IDs",
  ).map((runId) => requireNonBlankString(runId, "Child run ID"));
  const children = childRunIds.filter((runId) => runId !== record.runId);
  if (children.length === 0) return false;
  for (const childRunId of children) {
    const child = sourceSnapshot.find(
      (source) =>
        source.turnId === record.turnId &&
        source.runId === childRunId &&
        source.destinationFingerprint === record.destinationFingerprint &&
        source.eventKind === LIFECYCLE_POST_EVENT_KIND,
    );
    if (child === undefined) return true;
    const scope = captureScope(child);
    for (const destination of destinations) {
      const outcome = await readOutcome(scope, destination.id);
      if (outcome.status === "failed")
        throw new Error(`Could not read child delivery receipt: ${outcome.code}`);
      if (outcome.status !== "settled" || outcome.receipt.outcome !== "delivered") return true;
    }
  }
  return false;
}

function removeOutgoingEndTime(submission: PreparedRunSubmission): PreparedRunSubmission {
  const privacyContext =
    submission.privacyMode !== "metadata"
      ? undefined
      : submission.operation === "post"
        ? {
            status:
              submission.run.error !== undefined || submission.privacyContext?.status === "error"
                ? ("error" as const)
                : ("running" as const),
          }
        : {
            status:
              submission.privacyContext.status === "error"
                ? ("error" as const)
                : ("running" as const),
          };
  if (submission.operation === "post") {
    const run = { ...submission.run };
    delete run.end_time;
    return {
      ...submission,
      run,
      ...(privacyContext === undefined ? {} : { privacyContext }),
    };
  }
  const fields = submission.patch.fields.filter((field) => field !== "end_time");
  const values = { ...submission.patch.values };
  delete values.end_time;
  return {
    ...submission,
    patch: { fields, values },
    ...(privacyContext === undefined ? {} : { privacyContext }),
  };
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
