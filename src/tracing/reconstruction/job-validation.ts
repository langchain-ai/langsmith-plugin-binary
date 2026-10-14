import { validateIdentifier } from "../../storage/capture/paths.js";
import type { PreparedRunSubmission } from "../upload/models.js";
import { canonicalJson } from "../../storage/capture/utils/serialization.js";
import {
  canonicalJsonObject,
  ownDataField,
  requireBoolean,
  requireNonBlankString,
  requireOwnDataField,
  requirePlainRecord,
  requireSafeEpochMilliseconds,
  requireStringArray,
} from "../../utils/validation/objects.js";
import { isPlainRecord } from "../../utils/validation/objects.js";
import { snapshotData } from "../../utils/validation/snapshot.js";
import { assertKnownKeys } from "./known-keys.js";
import { projectSubmission } from "../lifecycle/projection.js";
import {
  RECONSTRUCTION_CONTEXT_FIELDS_MESSAGE,
  RECONSTRUCTION_ATTRIBUTION_CONTEXT_KEYS,
  RECONSTRUCTION_ATTRIBUTION_CONTEXT_OPTIONAL_KEYS,
  RECONSTRUCTION_CAPTURES_CANNOT_DEPEND_ON_THEMSELVES_MESSAGE,
  RECONSTRUCTION_CLOSURE_STATES,
  RECONSTRUCTION_DEPENDENCIES_MUST_BE_ARRAY_MESSAGE,
  RECONSTRUCTION_DEPENDENCIES_MUST_BE_UNIQUE_MESSAGE,
  RECONSTRUCTION_DEPENDENCY_SCOPE_MESSAGE,
  RECONSTRUCTION_DEPENDENCY_INTEGRATION_MESSAGE,
  RECONSTRUCTION_DEPENDENCY_KEYS,
  RECONSTRUCTION_EVENT_IDS_MUST_BE_UNIQUE_MESSAGE,
  RECONSTRUCTION_INTEGRATION_CHANGED_MESSAGE,
  RECONSTRUCTION_SOURCE_CONFLICT_MESSAGE,
  RECONSTRUCTION_JOB_HAS_UNSUPPORTED_FIELDS_MESSAGE,
  RECONSTRUCTION_JOB_INPUT_KEYS,
  RECONSTRUCTION_LABEL_EVENT_ID,
  RECONSTRUCTION_LABEL_EVENT_ID_FIELD,
  RECONSTRUCTION_LABEL_INTEGRATION,
  RECONSTRUCTION_LABEL_OUTPUT,
  RECONSTRUCTION_LABEL_RUN,
  RECONSTRUCTION_LABEL_RUN_ID,
  RECONSTRUCTION_LABEL_RUN_ID_FIELD,
  RECONSTRUCTION_LABEL_SOURCE_REF,
  RECONSTRUCTION_LABEL_SOURCE_REF_FIELD,
  RECONSTRUCTION_LABEL_SUBMISSION,
  RECONSTRUCTION_JOB_OPTIONAL_INPUT_KEYS,
  RECONSTRUCTION_METADATA_FULL_MODE_MESSAGE,
  RECONSTRUCTION_OUTPUTS_MUST_BE_ARRAY_MESSAGE,
  RECONSTRUCTION_OUTPUT_HAS_UNSUPPORTED_FIELDS_MESSAGE,
  RECONSTRUCTION_OUTPUT_KEYS,
  RECONSTRUCTION_OUTPUT_OPTIONAL_KEYS,
  RECONSTRUCTION_OUTPUT_SOURCE_REF_HAS_NO_SNAPSHOT_MESSAGE,
  RECONSTRUCTION_OUTPUT_REF_UNKNOWN_MESSAGE,
  RECONSTRUCTION_PINNED_BLANK_MESSAGE,
  RECONSTRUCTION_PINNED_UNIQUE_MESSAGE,
  RECONSTRUCTION_PRIVACY_MODE_IS_INVALID_MESSAGE,
  RECONSTRUCTION_EVIDENCE_IDENTITY_MESSAGE,
  RECONSTRUCTION_SNAPSHOT_NOT_READY_MESSAGE,
  RECONSTRUCTION_SNAPSHOT_OUTPUTS_REQUIRE_SOURCE_REF_MESSAGE,
  RECONSTRUCTION_SNAPSHOT_PRIVACY_MESSAGE,
  RECONSTRUCTION_SNAPSHOT_REFS_MUST_BE_UNIQUE_MESSAGE,
  RECONSTRUCTION_SNAPSHOT_REF_MUST_BELONG_TO_JOB_MESSAGE,
  RECONSTRUCTION_PATHLESS_REF_MESSAGE,
  RECONSTRUCTION_SOURCE_REFS_ARE_REQUIRED_MESSAGE,
  RECONSTRUCTION_SUBMISSION_INVALID_MESSAGE,
  RECONSTRUCTION_SOURCE_REFS_MUST_BE_UNIQUE_MESSAGE,
  RECONSTRUCTION_SNAPSHOTS_EMPTY_MESSAGE,
  RECONSTRUCTION_SNAPSHOT_COVERAGE_MESSAGE,
  RECONSTRUCTION_SNAPSHOT_FIELDS_MESSAGE,
  RECONSTRUCTION_SOURCE_SNAPSHOT_KEYS,
  RECONSTRUCTION_SOURCE_SNAPSHOT_OPTIONAL_KEYS,
  RECONSTRUCTION_SNAPSHOT_START_TIME_MESSAGE,
  RECONSTRUCTION_TOOL_ORIGIN_HAS_UNSUPPORTED_FIELDS_MESSAGE,
  RECONSTRUCTION_TOOL_ORIGIN_KEYS,
  RECONSTRUCTION_TOOL_ORIGIN_OPTIONAL_KEYS,
  RECONSTRUCTION_CLOSURE_STATE_MESSAGE,
  RECONSTRUCTION_TURN_EVIDENCE_KEYS,
  RECONSTRUCTION_TURN_EVIDENCE_KEYS_WITH_ROOT,
  RECONSTRUCTION_EVIDENCE_STRUCTURAL_MESSAGE,
} from "./constants.js";
import type {
  ReconstructionAttributionContext,
  ReconstructionJob,
  ReconstructionJobInput,
  ReconstructionOutput,
  ReconstructionSourceSnapshot,
  ReconstructionToolOrigin,
  ReconstructionTurnEvidence,
  ReconstructionValidatedOutput,
} from "./models.js";
import { scopeOf } from "../../storage/capture/scope.js";

function readEventId(output: Record<string, unknown>, seen: Set<string>): string {
  const eventId = requireNonBlankString(
    requireOwnDataField(output, "eventId"),
    RECONSTRUCTION_LABEL_EVENT_ID,
  );
  validateIdentifier(eventId, RECONSTRUCTION_LABEL_EVENT_ID_FIELD);
  if (seen.has(eventId)) throw new TypeError(RECONSTRUCTION_EVENT_IDS_MUST_BE_UNIQUE_MESSAGE);
  seen.add(eventId);
  return eventId;
}

function isPreparedSubmission(value: object): value is PreparedRunSubmission {
  const fields = value as Record<string, unknown>;
  return (
    typeof fields["integration"] === "string" &&
    (fields["privacyMode"] === "full" || fields["privacyMode"] === "metadata") &&
    isPlainRecord(fields["run"])
  );
}

function readSubmission(
  output: Record<string, unknown>,
  job: ReconstructionJob,
): PreparedRunSubmission {
  const submission = canonicalJsonObject(
    requirePlainRecord(requireOwnDataField(output, "submission"), RECONSTRUCTION_LABEL_SUBMISSION),
    RECONSTRUCTION_LABEL_SUBMISSION,
  );
  const integration = requireNonBlankString(
    requireOwnDataField(submission, "integration"),
    RECONSTRUCTION_LABEL_INTEGRATION,
  );
  if (integration !== job.integration)
    throw new TypeError(RECONSTRUCTION_INTEGRATION_CHANGED_MESSAGE);
  const privacyMode = requireOwnDataField(submission, "privacyMode");
  if (privacyMode !== "full" && privacyMode !== "metadata")
    throw new TypeError(RECONSTRUCTION_PRIVACY_MODE_IS_INVALID_MESSAGE);
  if (job.privacyMode === "metadata" && privacyMode === "full")
    throw new TypeError(RECONSTRUCTION_METADATA_FULL_MODE_MESSAGE);
  if (!isPreparedSubmission(submission))
    throw new TypeError(RECONSTRUCTION_SUBMISSION_INVALID_MESSAGE);
  return submission;
}

function readRunId(submission: PreparedRunSubmission): string {
  const run = requirePlainRecord(submission.run, RECONSTRUCTION_LABEL_RUN);
  const runId = requireNonBlankString(requireOwnDataField(run, "id"), RECONSTRUCTION_LABEL_RUN_ID);
  validateIdentifier(runId, RECONSTRUCTION_LABEL_RUN_ID_FIELD);
  return runId;
}

function readDependencies(
  output: Record<string, unknown>,
  job: ReconstructionJob,
  eventId: string,
): ReconstructionOutput["dependencies"] {
  const field = ownDataField(output, "dependencies");
  if (!field.present) return undefined;
  if (!Array.isArray(field.value))
    throw new TypeError(RECONSTRUCTION_DEPENDENCIES_MUST_BE_ARRAY_MESSAGE);
  return validateDependencies(field.value, job, eventId);
}

function readTurnEvidence(
  output: Record<string, unknown>,
  job: ReconstructionJob,
): ReconstructionOutput["turnEvidence"] {
  const field = ownDataField(output, "turnEvidence");
  const turnEvidence = field.present ? validateTurnEvidence(field.value) : undefined;
  if (
    turnEvidence !== undefined &&
    ((job.turnEvidence.rootRunId !== undefined &&
      turnEvidence.rootRunId !== job.turnEvidence.rootRunId) ||
      job.turnEvidence.childRunIds.some((id) => !turnEvidence.childRunIds.includes(id)))
  ) {
    throw new TypeError(RECONSTRUCTION_EVIDENCE_IDENTITY_MESSAGE);
  }
  return turnEvidence;
}

function readSourceRef(output: Record<string, unknown>): string | undefined {
  const field = ownDataField(output, "sourceRef");
  if (!field.present) return undefined;
  const sourceRef = requireNonBlankString(field.value, RECONSTRUCTION_LABEL_SOURCE_REF);
  validateIdentifier(sourceRef, RECONSTRUCTION_LABEL_SOURCE_REF_FIELD);
  return sourceRef;
}

function sourceAgeFor(
  job: ReconstructionJob,
  sourceRef: string | undefined,
  jobCapturedAtMs: number,
): number | undefined {
  if (job.sourceSnapshots !== undefined) {
    if (sourceRef === undefined)
      throw new TypeError(RECONSTRUCTION_SNAPSHOT_OUTPUTS_REQUIRE_SOURCE_REF_MESSAGE);
    const snapshot = job.sourceSnapshots.find((candidate) => candidate.sourceRef === sourceRef);
    if (snapshot === undefined)
      throw new TypeError(RECONSTRUCTION_OUTPUT_SOURCE_REF_HAS_NO_SNAPSHOT_MESSAGE);
    return snapshot.sourceAgeStartedAtMs;
  }
  if (sourceRef !== undefined && !job.sourceRefs.includes(sourceRef))
    throw new TypeError(RECONSTRUCTION_OUTPUT_REF_UNKNOWN_MESSAGE);
  return job.sourceAgeStartedAtMs ?? jobCapturedAtMs;
}

function validateOutput(
  item: unknown,
  job: ReconstructionJob,
  jobCapturedAtMs: number,
  seen: Set<string>,
): ReconstructionValidatedOutput {
  const output = requirePlainRecord(item, RECONSTRUCTION_LABEL_OUTPUT);
  assertKnownKeys(
    output,
    RECONSTRUCTION_OUTPUT_KEYS,
    RECONSTRUCTION_OUTPUT_OPTIONAL_KEYS,
    RECONSTRUCTION_OUTPUT_HAS_UNSUPPORTED_FIELDS_MESSAGE,
  );
  const eventId = readEventId(output, seen);
  const submission = readSubmission(output, job);
  const runId = readRunId(submission);
  const dependencies = readDependencies(output, job, eventId);
  const turnEvidence = readTurnEvidence(output, job);
  const sourceRef = readSourceRef(output);
  const sourceAgeStartedAtMs = sourceAgeFor(job, sourceRef, jobCapturedAtMs);
  return {
    eventId,
    runId,
    submission,
    ...(turnEvidence === undefined ? {} : { turnEvidence }),
    ...(sourceRef === undefined ? {} : { sourceRef }),
    ...(sourceAgeStartedAtMs === undefined ? {} : { sourceAgeStartedAtMs }),
    ...(dependencies === undefined ? {} : { dependencies }),
  };
}

export function validateOutputs(
  value: unknown,
  job: ReconstructionJob,
  jobCapturedAtMs: number,
): ReconstructionValidatedOutput[] {
  if (!Array.isArray(value)) throw new TypeError(RECONSTRUCTION_OUTPUTS_MUST_BE_ARRAY_MESSAGE);
  const seen = new Set<string>();
  return value.map((item) => validateOutput(item, job, jobCapturedAtMs, seen));
}

function validateDependencies(
  value: unknown,
  job: ReconstructionJob,
  eventId: string,
): NonNullable<ReconstructionOutput["dependencies"]> {
  if (!Array.isArray(value)) throw new TypeError(RECONSTRUCTION_DEPENDENCIES_MUST_BE_ARRAY_MESSAGE);
  const dependent = { ...scopeOf(job), eventId };
  const seen = new Set<string>();
  return value.map((item) => {
    const source = requirePlainRecord(item, "Reconstruction dependency");
    const keys = Object.keys(source).toSorted();
    if (canonicalJson(keys) !== canonicalJson(RECONSTRUCTION_DEPENDENCY_KEYS))
      throw new TypeError(RECONSTRUCTION_DEPENDENCY_SCOPE_MESSAGE);
    const integration = requireNonBlankString(
      requireOwnDataField(source, "integration"),
      "Dependency integration",
    );
    if (integration !== job.integration)
      throw new TypeError(RECONSTRUCTION_DEPENDENCY_INTEGRATION_MESSAGE);
    const scope = {
      integration,
      sessionId: requireNonBlankString(
        requireOwnDataField(source, "sessionId"),
        "Dependency session ID",
      ),
      turnId: requireNonBlankString(requireOwnDataField(source, "turnId"), "Dependency turn ID"),
      eventId: requireNonBlankString(requireOwnDataField(source, "eventId"), "Dependency event ID"),
    };
    validateIdentifier(scope.sessionId, "dependency session ID");
    validateIdentifier(scope.turnId, "dependency turn ID");
    validateIdentifier(scope.eventId, "dependency event ID");
    if (
      scope.sessionId === dependent.sessionId &&
      scope.turnId === dependent.turnId &&
      scope.eventId === dependent.eventId
    ) {
      throw new TypeError(RECONSTRUCTION_CAPTURES_CANNOT_DEPEND_ON_THEMSELVES_MESSAGE);
    }
    const key = canonicalJson(scope);
    if (seen.has(key)) throw new TypeError(RECONSTRUCTION_DEPENDENCIES_MUST_BE_UNIQUE_MESSAGE);
    seen.add(key);
    return scope;
  });
}

export function validateJobInput(
  value: ReconstructionJobInput,
  integration: ReconstructionJob["integration"],
  sessionId: string,
  accountFingerprint: string,
): ReconstructionJob {
  const input = requirePlainRecord(
    snapshotData(requirePlainRecord(value, "Reconstruction job")),
    "Reconstruction job",
  );
  assertKnownKeys(
    input,
    RECONSTRUCTION_JOB_INPUT_KEYS,
    RECONSTRUCTION_JOB_OPTIONAL_INPUT_KEYS,
    RECONSTRUCTION_JOB_HAS_UNSUPPORTED_FIELDS_MESSAGE,
  );
  const turnId = requireNonBlankString(requireOwnDataField(input, "turnId"), "Turn ID");
  const eventId = requireNonBlankString(requireOwnDataField(input, "eventId"), "Event ID");
  validateIdentifier(turnId, "turn ID");
  validateIdentifier(eventId, "event ID");
  const privacyMode = requireOwnDataField(input, "privacyMode");
  if (privacyMode !== "full" && privacyMode !== "metadata")
    throw new TypeError(RECONSTRUCTION_PRIVACY_MODE_IS_INVALID_MESSAGE);
  const sourceRefs = requireStringArray(requireOwnDataField(input, "sourceRefs"), "Source refs");
  if (sourceRefs.length === 0) throw new TypeError(RECONSTRUCTION_SOURCE_REFS_ARE_REQUIRED_MESSAGE);
  if (new Set(sourceRefs).size !== sourceRefs.length)
    throw new TypeError(RECONSTRUCTION_SOURCE_REFS_MUST_BE_UNIQUE_MESSAGE);
  for (const ref of sourceRefs) {
    requireNonBlankString(ref, "Source ref");
    validateIdentifier(ref, "source ref");
  }
  const turnEvidence = validateTurnEvidence(requireOwnDataField(input, "turnEvidence"));
  const sourceSnapshotsField = ownDataField(input, "sourceSnapshots");
  const sourceAgeField = ownDataField(input, "sourceAgeStartedAtMs");
  if (sourceSnapshotsField.present && sourceAgeField.present)
    throw new TypeError(RECONSTRUCTION_SOURCE_CONFLICT_MESSAGE);
  const sourceAgeStartedAtMs = sourceAgeField.present
    ? requireSafeEpochMilliseconds(sourceAgeField.value, "Source age")
    : undefined;
  const sourceSnapshots = sourceSnapshotsField.present
    ? validateSourceSnapshots(sourceSnapshotsField.value, integration, privacyMode, sourceRefs)
    : undefined;
  return {
    integration,
    sessionId,
    turnId,
    eventId,
    accountFingerprint,
    sourceRefs,
    privacyMode,
    turnEvidence,
    ...(sourceSnapshots === undefined ? {} : { sourceSnapshots }),
    ...(sourceAgeStartedAtMs === undefined ? {} : { sourceAgeStartedAtMs }),
  };
}

function snapshotSubmission(
  source: Record<string, unknown>,
  integration: ReconstructionJob["integration"],
  privacyMode: ReconstructionJob["privacyMode"],
): PreparedRunSubmission {
  const submission = canonicalJsonObject(
    requirePlainRecord(requireOwnDataField(source, "submission"), "Prepared submission"),
    "Prepared submission",
  );
  if (requireOwnDataField(submission, "privacyMode") !== privacyMode)
    throw new TypeError(RECONSTRUCTION_SNAPSHOT_PRIVACY_MESSAGE);
  if (submission["operation"] === "post") {
    const run = requirePlainRecord(requireOwnDataField(submission, "run"), "Prepared run");
    if (!ownDataField(run, "start_time").present)
      throw new TypeError(RECONSTRUCTION_SNAPSHOT_START_TIME_MESSAGE);
  }
  const projected = projectSubmission(submission, integration);
  if (projected.status !== "ready") throw new TypeError(RECONSTRUCTION_SNAPSHOT_NOT_READY_MESSAGE);
  return canonicalJsonObject(
    { ...projected.value.payload, metadata: projected.value.metadata },
    "Projected submission",
  ) as unknown as PreparedRunSubmission;
}

function validateSourceSnapshot(
  item: unknown,
  integration: ReconstructionJob["integration"],
  privacyMode: ReconstructionJob["privacyMode"],
  sourceRefs: readonly string[],
  seen: Set<string>,
): ReconstructionSourceSnapshot {
  const source = requirePlainRecord(item, "Reconstruction source snapshot");
  assertKnownKeys(
    source,
    RECONSTRUCTION_SOURCE_SNAPSHOT_KEYS,
    RECONSTRUCTION_SOURCE_SNAPSHOT_OPTIONAL_KEYS,
    RECONSTRUCTION_SNAPSHOT_FIELDS_MESSAGE,
  );
  const sourceRef = requireNonBlankString(requireOwnDataField(source, "sourceRef"), "Source ref");
  validatePathlessSourceRef(sourceRef);
  if (!sourceRefs.includes(sourceRef))
    throw new TypeError(RECONSTRUCTION_SNAPSHOT_REF_MUST_BELONG_TO_JOB_MESSAGE);
  if (seen.has(sourceRef)) throw new TypeError(RECONSTRUCTION_SNAPSHOT_REFS_MUST_BE_UNIQUE_MESSAGE);
  seen.add(sourceRef);
  const sourceAgeStartedAtMs = requireSafeEpochMilliseconds(
    requireOwnDataField(source, "sourceAgeStartedAtMs"),
    "Source age",
  );
  const submission = snapshotSubmission(source, integration, privacyMode);
  const attributionField = ownDataField(source, "attributionContext");
  const attributionContext = attributionField.present
    ? validateAttributionContext(attributionField.value, privacyMode)
    : undefined;
  return {
    sourceRef,
    submission,
    sourceAgeStartedAtMs,
    ...(attributionContext === undefined ? {} : { attributionContext }),
  };
}

export function validateSourceSnapshots(
  value: unknown,
  integration: ReconstructionJob["integration"],
  privacyMode: ReconstructionJob["privacyMode"],
  sourceRefs: readonly string[],
): ReconstructionSourceSnapshot[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError(RECONSTRUCTION_SNAPSHOTS_EMPTY_MESSAGE);
  for (const ref of sourceRefs) validatePathlessSourceRef(ref);
  const seen = new Set<string>();
  const snapshots = value.map((item) =>
    validateSourceSnapshot(item, integration, privacyMode, sourceRefs, seen),
  );
  if (snapshots.length !== sourceRefs.length)
    throw new TypeError(RECONSTRUCTION_SNAPSHOT_COVERAGE_MESSAGE);
  return snapshots;
}

function validatePathlessSourceRef(sourceRef: string): void {
  validateIdentifier(sourceRef, "source ref");
  if (sourceRef.includes("/") || sourceRef.includes("\\"))
    throw new TypeError(RECONSTRUCTION_PATHLESS_REF_MESSAGE);
}

function validateAttributionContext(
  value: unknown,
  privacyMode: ReconstructionJob["privacyMode"],
): ReconstructionAttributionContext {
  const context = requirePlainRecord(value, "Attribution context");
  assertKnownKeys(
    context,
    RECONSTRUCTION_ATTRIBUTION_CONTEXT_KEYS,
    RECONSTRUCTION_ATTRIBUTION_CONTEXT_OPTIONAL_KEYS,
    RECONSTRUCTION_CONTEXT_FIELDS_MESSAGE,
  );
  const origin = requirePlainRecord(requireOwnDataField(context, "toolOrigin"), "Tool origin");
  assertKnownKeys(
    origin,
    RECONSTRUCTION_TOOL_ORIGIN_KEYS,
    RECONSTRUCTION_TOOL_ORIGIN_OPTIONAL_KEYS,
    RECONSTRUCTION_TOOL_ORIGIN_HAS_UNSUPPORTED_FIELDS_MESSAGE,
  );
  const namedAPath = requireBoolean(requireOwnDataField(origin, "namedAPath"), "namedAPath");
  const pathField = ownDataField(origin, "path");
  const cwdField = ownDataField(origin, "cwd");
  const pinnedField = ownDataField(context, "pinnedRepositoryKeys");
  const toolOrigin: ReconstructionToolOrigin =
    privacyMode === "metadata"
      ? { namedAPath }
      : {
          ...(pathField.present
            ? { path: requireNonBlankString(pathField.value, "Tool path") }
            : {}),
          ...(cwdField.present ? { cwd: requireNonBlankString(cwdField.value, "Tool cwd") } : {}),
          namedAPath,
        };
  let pinnedRepositoryKeys: string[] | undefined;
  if (privacyMode === "full" && pinnedField.present) {
    pinnedRepositoryKeys = requireStringArray(pinnedField.value, "Pinned repository keys");
    if (pinnedRepositoryKeys.some((key) => key.trim().length === 0))
      throw new TypeError(RECONSTRUCTION_PINNED_BLANK_MESSAGE);
    if (new Set(pinnedRepositoryKeys).size !== pinnedRepositoryKeys.length)
      throw new TypeError(RECONSTRUCTION_PINNED_UNIQUE_MESSAGE);
  }
  return {
    toolOrigin,
    ...(pinnedRepositoryKeys === undefined ? {} : { pinnedRepositoryKeys }),
  };
}

export function validateTurnEvidence(value: unknown): ReconstructionTurnEvidence {
  const evidence = requirePlainRecord(value, "Turn evidence");
  canonicalJson(evidence);
  const keys = Object.keys(evidence).toSorted();
  if (
    RECONSTRUCTION_TURN_EVIDENCE_KEYS.some((key) => !keys.includes(key)) ||
    keys.some(
      (key) =>
        !RECONSTRUCTION_TURN_EVIDENCE_KEYS_WITH_ROOT.includes(
          key as (typeof RECONSTRUCTION_TURN_EVIDENCE_KEYS_WITH_ROOT)[number],
        ),
    )
  )
    throw new TypeError(RECONSTRUCTION_EVIDENCE_STRUCTURAL_MESSAGE);
  const childRunIds = requireStringArray(
    requireOwnDataField(evidence, "childRunIds"),
    "Child run IDs",
  );
  for (const childRunId of childRunIds) {
    requireNonBlankString(childRunId, "Child run ID");
    validateIdentifier(childRunId, "child run ID");
  }
  const rootRunIdField = ownDataField(evidence, "rootRunId");
  const rootRunId = rootRunIdField.present
    ? requireNonBlankString(rootRunIdField.value, "Root run ID")
    : undefined;
  if (rootRunId !== undefined) validateIdentifier(rootRunId, "root run ID");
  const closureState = requireOwnDataField(evidence, "closureState");
  if (
    typeof closureState !== "string" ||
    !RECONSTRUCTION_CLOSURE_STATES.includes(
      closureState as ReconstructionTurnEvidence["closureState"],
    )
  ) {
    throw new TypeError(RECONSTRUCTION_CLOSURE_STATE_MESSAGE);
  }
  return {
    ...(rootRunId === undefined ? {} : { rootRunId }),
    childRunIds,
    closureState: closureState as ReconstructionTurnEvidence["closureState"],
  };
}
