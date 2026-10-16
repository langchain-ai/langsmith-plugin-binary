import {
  buildCodingAgentMetadata,
  prepareCodingAgentMetadataProvenance,
} from "../../metadata/index.js";
import { ATTRIBUTION_IDENTIFIER_KEY, GIT_METADATA_KEYS } from "../../metadata/constants.js";
import type { CodingAgentIntegration } from "../../metadata/models.js";
import type {
  CaptureScope,
  EnumeratedCapture,
  JsonValue,
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
  LIFECYCLE_SETTLEMENT_EVENT_KIND,
  LIFECYCLE_TURN_CLOSURE_STATES,
} from "./constants.js";
import type { LifecycleEndTimeWithholdingInput } from "./models.js";
import { scopeKey, scopeOf } from "../../storage/capture/scope.js";

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
  return new Map(sources.map((source) => [scopeKey(scopeOf(source)), source]));
}

function attributionMetadataReady(projected: Record<string, unknown>): boolean {
  const repository = projected[GIT_METADATA_KEYS.repository];
  const identifier = projected[ATTRIBUTION_IDENTIFIER_KEY];
  return (
    typeof repository === "string" &&
    repository.length > 0 &&
    typeof identifier === "string" &&
    identifier.length > 0
  );
}

export async function withholdUnresolvedEndTime(
  input: LifecycleEndTimeWithholdingInput,
): Promise<PreparedRunSubmission | undefined> {
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
    const key = scopeKey(scope);
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
    const childCaptures = sourceSnapshot.filter(
      (source) =>
        source.runId === childRunId &&
        source.destinationFingerprint === record.destinationFingerprint &&
        source.eventKind === LIFECYCLE_POST_EVENT_KIND,
    );
    if (childCaptures.length === 0) return true;
    for (const child of childCaptures) {
      const scope = scopeOf(child);
      for (const destination of destinations) {
        const outcome = await readOutcome(scope, destination.id);
        if (outcome.status === "failed")
          throw new Error(`Could not read child delivery receipt: ${outcome.code}`);
        if (outcome.status !== "settled" || outcome.receipt.outcome !== "delivered") return true;
      }
    }
  }
  return false;
}

function removeOutgoingEndTime(
  submission: PreparedRunSubmission,
): PreparedRunSubmission | undefined {
  if (submission.operation === "patch") return undefined;
  const privacyContext =
    submission.privacyMode !== "metadata"
      ? undefined
      : {
          status:
            submission.run.error !== undefined || submission.privacyContext?.status === "error"
              ? ("error" as const)
              : ("running" as const),
        };
  const run = { ...submission.run };
  delete run.end_time;
  return {
    ...submission,
    run,
    ...(privacyContext === undefined ? {} : { privacyContext }),
  };
}

export function isHeldUpdate(
  record: StoredCapture,
  captures: readonly EnumeratedCapture[],
  integration: CodingAgentIntegration,
): boolean {
  if (record.eventKind !== LIFECYCLE_PATCH_EVENT_KIND) return false;
  if (field(record.metadataProvenance, "runType") !== "tool") return false;
  const fields = field(field(record.normalizedPayload, "patch"), "fields");
  if (!Array.isArray(fields) || !fields.includes("end_time")) return false;
  if (storedAttributionReadiness(record, integration)) return false;
  return !captures.some(
    (capture) =>
      capture.record.eventKind === LIFECYCLE_SETTLEMENT_EVENT_KIND &&
      capture.record.runId === record.runId,
  );
}

function field(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;
}
