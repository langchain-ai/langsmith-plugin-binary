import type { CaptureInput, CaptureScope, StoredCapture } from "../../storage/capture/models.js";
import { assertKnownKeys } from "./known-keys.js";
import { identifierHash, validateIdentifier } from "../../storage/capture/paths.js";
import { canonicalJson, canonicalValue } from "../../storage/capture/utils/serialization.js";
import {
  ownDataField,
  requireNonBlankString,
  requirePlainRecord,
  requireSafeEpochMilliseconds,
  requireStringArray,
} from "../../utils/validation/objects.js";
import { snapshotData } from "../../utils/validation/snapshot.js";
import {
  RECONSTRUCTION_STORED_PRIVACY_MESSAGE,
  RECONSTRUCTION_JOB_DEPENDENCIES_MESSAGE,
  RECONSTRUCTION_PROVENANCE_MESSAGE,
  RECONSTRUCTION_JOB_KIND,
  RECONSTRUCTION_MAPPING_EVENT_ID_PREFIX,
  RECONSTRUCTION_MAPPING_KIND,
  RECONSTRUCTION_RECORD_VERSION,
  RECONSTRUCTION_RUN_ID_PREFIX,
  RECONSTRUCTION_STORED_JOB_KEYS,
  RECONSTRUCTION_STORED_JOB_OPTIONAL_KEYS,
  RECONSTRUCTION_STORED_DEPENDENCIES_MESSAGE,
  RECONSTRUCTION_STORED_EVENTS_UNIQUE_MESSAGE,
  RECONSTRUCTION_STORED_SOURCE_CONFLICT_MESSAGE,
  RECONSTRUCTION_STORED_FIELDS_MESSAGE,
  RECONSTRUCTION_STORED_NAMESPACE_MESSAGE,
  RECONSTRUCTION_STORED_NO_OUTPUTS_MESSAGE,
  RECONSTRUCTION_STORED_REFS_EMPTY_MESSAGE,
  RECONSTRUCTION_STORED_REFS_UNIQUE_MESSAGE,
  RECONSTRUCTION_UNSUPPORTED_RECONSTRUCTION_JOB_MESSAGE,
  RECONSTRUCTION_UNSUPPORTED_RECONSTRUCTION_MAPPING_MESSAGE,
} from "./constants.js";
import type {
  ReconstructionJob,
  ReconstructionOutput,
  ReconstructionValidatedOutput,
  StoredReconstructionMapping,
} from "./models.js";
import { scopeOf } from "../../storage/capture/scope.js";
import { validateSourceSnapshots, validateTurnEvidence } from "./job-validation.js";

export function snapshotJob(job: ReconstructionJob): ReconstructionJob {
  return Object.freeze({
    ...job,
    sourceRefs: Object.freeze([...job.sourceRefs]),
    ...(job.sourceSnapshots === undefined
      ? {}
      : {
          sourceSnapshots: Object.freeze(
            job.sourceSnapshots.map((snapshot) =>
              Object.freeze({
                ...snapshot,
                submission: snapshotData(snapshot.submission),
                ...(snapshot.attributionContext === undefined
                  ? {}
                  : {
                      attributionContext: Object.freeze({
                        toolOrigin: Object.freeze({ ...snapshot.attributionContext.toolOrigin }),
                        ...(snapshot.attributionContext.pinnedRepositoryKeys === undefined
                          ? {}
                          : {
                              pinnedRepositoryKeys: Object.freeze([
                                ...snapshot.attributionContext.pinnedRepositoryKeys,
                              ]),
                            }),
                      }),
                    }),
              }),
            ),
          ),
        }),
    turnEvidence: Object.freeze({
      ...(job.turnEvidence.rootRunId === undefined
        ? {}
        : { rootRunId: job.turnEvidence.rootRunId }),
      childRunIds: Object.freeze([...job.turnEvidence.childRunIds]),
      closureState: job.turnEvidence.closureState,
    }),
  });
}

function jobSourceAgeStartedAtMs(job: ReconstructionJob): number | undefined {
  if (job.sourceSnapshots !== undefined) {
    return Math.max(...job.sourceSnapshots.map(({ sourceAgeStartedAtMs }) => sourceAgeStartedAtMs));
  }
  return job.sourceAgeStartedAtMs;
}

export function jobRecord(job: ReconstructionJob): CaptureInput {
  const scope = scopeOf(job);
  const sourceAgeStartedAtMs = jobSourceAgeStartedAtMs(job);
  return {
    ...scope,
    runId: `${RECONSTRUCTION_RUN_ID_PREFIX}${identifierHash(canonicalJson(scope))}`,
    destinationFingerprint: job.accountFingerprint,
    eventKind: RECONSTRUCTION_JOB_KIND,
    ...(sourceAgeStartedAtMs === undefined ? {} : { sourceAgeStartedAtMs }),
    normalizedPayload: canonicalValue(
      {
        recordVersion: RECONSTRUCTION_RECORD_VERSION,
        privacyMode: job.privacyMode,
        sourceRefs: [...job.sourceRefs],
        ...(job.sourceAgeStartedAtMs === undefined
          ? {}
          : { sourceAgeStartedAtMs: job.sourceAgeStartedAtMs }),
        ...(job.sourceSnapshots === undefined
          ? {}
          : {
              sourceSnapshots: job.sourceSnapshots.map((snapshot) => ({
                sourceRef: snapshot.sourceRef,
                submission: snapshot.submission,
                sourceAgeStartedAtMs: snapshot.sourceAgeStartedAtMs,
                ...(snapshot.attributionContext === undefined
                  ? {}
                  : { attributionContext: snapshot.attributionContext }),
              })),
            }),
      },
      new Set<object>(),
    ),
    turnEvidence: canonicalValue(job.turnEvidence, new Set<object>()),
    metadataProvenance: {},
  };
}

export function mappingRecord(
  job: ReconstructionJob,
  outputs: ReconstructionValidatedOutput[],
): CaptureInput {
  const scope = mappingScope(job);
  return {
    ...scope,
    runId: scope.eventId,
    destinationFingerprint: job.accountFingerprint,
    eventKind: RECONSTRUCTION_MAPPING_KIND,
    normalizedPayload: {
      recordVersion: RECONSTRUCTION_RECORD_VERSION,
      jobEventId: job.eventId,
      outputs: outputs.map(({ eventId, runId, dependencies, sourceRef, turnEvidence }) => ({
        eventId,
        runId,
        ...(turnEvidence === undefined
          ? {}
          : { turnEvidence: canonicalValue(turnEvidence, new Set<object>()) }),
        ...(sourceRef === undefined ? {} : { sourceRef }),
        ...(dependencies === undefined
          ? {}
          : {
              dependencies: dependencies.map((dependency) => ({
                integration: dependency.integration,
                sessionId: dependency.sessionId,
                turnId: dependency.turnId,
                eventId: dependency.eventId,
              })),
            }),
      })),
    },
    turnEvidence: canonicalValue(job.turnEvidence, new Set<object>()),
    metadataProvenance: {},
  };
}

function readStoredSources(
  payload: Record<string, unknown>,
  integration: ReconstructionJob["integration"],
  privacyMode: ReconstructionJob["privacyMode"],
): Pick<ReconstructionJob, "sourceRefs" | "sourceSnapshots" | "sourceAgeStartedAtMs"> {
  const sourceRefs = requireStringArray(payload["sourceRefs"], "Stored source refs");
  if (sourceRefs.length === 0) throw new Error(RECONSTRUCTION_STORED_REFS_EMPTY_MESSAGE);
  if (new Set(sourceRefs).size !== sourceRefs.length)
    throw new Error(RECONSTRUCTION_STORED_REFS_UNIQUE_MESSAGE);
  for (const ref of sourceRefs) {
    requireNonBlankString(ref, "Stored source ref");
    validateIdentifier(ref, "source ref");
  }
  const sourceSnapshotsField = ownDataField(payload, "sourceSnapshots");
  const sourceAgeField = ownDataField(payload, "sourceAgeStartedAtMs");
  if (sourceSnapshotsField.present && sourceAgeField.present)
    throw new Error(RECONSTRUCTION_STORED_SOURCE_CONFLICT_MESSAGE);
  const sourceAgeStartedAtMs = sourceAgeField.present
    ? requireSafeEpochMilliseconds(sourceAgeField.value, "Stored source age")
    : undefined;
  const sourceSnapshots = sourceSnapshotsField.present
    ? validateSourceSnapshots(sourceSnapshotsField.value, integration, privacyMode, sourceRefs)
    : undefined;
  return {
    sourceRefs,
    ...(sourceSnapshots === undefined ? {} : { sourceSnapshots }),
    ...(sourceAgeStartedAtMs === undefined ? {} : { sourceAgeStartedAtMs }),
  };
}

export function readJob(
  record: StoredCapture,
  integration: ReconstructionJob["integration"],
): ReconstructionJob {
  if (record.integration !== integration || record.eventKind !== RECONSTRUCTION_JOB_KIND)
    throw new Error(RECONSTRUCTION_STORED_NAMESPACE_MESSAGE);
  const payload = requirePlainRecord(record.normalizedPayload, "Stored reconstruction job");
  if (payload["recordVersion"] !== RECONSTRUCTION_RECORD_VERSION)
    throw new Error(RECONSTRUCTION_UNSUPPORTED_RECONSTRUCTION_JOB_MESSAGE);
  assertKnownKeys(
    payload,
    RECONSTRUCTION_STORED_JOB_KEYS,
    RECONSTRUCTION_STORED_JOB_OPTIONAL_KEYS,
    RECONSTRUCTION_STORED_FIELDS_MESSAGE,
  );
  const privacyMode = payload["privacyMode"];
  if (privacyMode !== "full" && privacyMode !== "metadata")
    throw new Error(RECONSTRUCTION_STORED_PRIVACY_MESSAGE);
  const sources = readStoredSources(payload, integration, privacyMode);
  const turnEvidence = validateTurnEvidence(record.turnEvidence);
  if (
    Object.keys(requirePlainRecord(record.metadataProvenance, "Stored metadata provenance"))
      .length > 0
  )
    throw new Error(RECONSTRUCTION_PROVENANCE_MESSAGE);
  if (record.dependencies !== undefined) throw new Error(RECONSTRUCTION_JOB_DEPENDENCIES_MESSAGE);
  return {
    integration,
    sessionId: record.sessionId,
    turnId: record.turnId,
    eventId: record.eventId,
    accountFingerprint: record.destinationFingerprint,
    privacyMode,
    turnEvidence,
    ...sources,
  };
}

export function readMapping(record: StoredCapture): StoredReconstructionMapping {
  if (record.eventKind !== RECONSTRUCTION_MAPPING_KIND)
    throw new Error(RECONSTRUCTION_UNSUPPORTED_RECONSTRUCTION_MAPPING_MESSAGE);
  const payload = requirePlainRecord(record.normalizedPayload, "Stored reconstruction mapping");
  if (payload["recordVersion"] !== RECONSTRUCTION_RECORD_VERSION)
    throw new Error(RECONSTRUCTION_UNSUPPORTED_RECONSTRUCTION_MAPPING_MESSAGE);
  const jobEventId = requireNonBlankString(payload["jobEventId"], "Job event ID");
  const outputs = payload["outputs"];
  if (!Array.isArray(outputs) || outputs.length === 0)
    throw new Error(RECONSTRUCTION_STORED_NO_OUTPUTS_MESSAGE);
  const seen = new Set<string>();
  const normalizedOutputs = outputs.map((value) => {
    const output = requirePlainRecord(value, "Stored reconstruction output");
    const eventId = requireNonBlankString(output["eventId"], "Output event ID");
    const runId = requireNonBlankString(output["runId"], "Output run ID");
    validateIdentifier(eventId, "output event ID");
    validateIdentifier(runId, "output run ID");
    if (seen.has(eventId)) throw new Error(RECONSTRUCTION_STORED_EVENTS_UNIQUE_MESSAGE);
    seen.add(eventId);
    const dependenciesField = ownDataField(output, "dependencies");
    const sourceRefField = ownDataField(output, "sourceRef");
    const evidenceField = ownDataField(output, "turnEvidence");
    const turnEvidence = evidenceField.present
      ? validateTurnEvidence(evidenceField.value)
      : undefined;
    let sourceRef: string | undefined;
    if (sourceRefField.present) {
      sourceRef = requireNonBlankString(sourceRefField.value, "Output source ref");
      validateIdentifier(sourceRef, "output source ref");
    }
    let dependencies: ReconstructionOutput["dependencies"];
    if (dependenciesField.present) {
      if (!Array.isArray(dependenciesField.value))
        throw new Error(RECONSTRUCTION_STORED_DEPENDENCIES_MESSAGE);
      dependencies = dependenciesField.value as ReconstructionOutput["dependencies"];
    }
    return {
      eventId,
      runId,
      ...(turnEvidence === undefined ? {} : { turnEvidence }),
      ...(sourceRef === undefined ? {} : { sourceRef }),
      ...(dependencies === undefined ? {} : { dependencies }),
    };
  });
  return { recordVersion: RECONSTRUCTION_RECORD_VERSION, jobEventId, outputs: normalizedOutputs };
}

export function sameOutputMapping(
  mapping: StoredReconstructionMapping,
  outputs: ReconstructionValidatedOutput[],
): boolean {
  return (
    canonicalJson(mapping.outputs) ===
    canonicalJson(
      outputs.map(({ eventId, runId, dependencies, sourceRef, turnEvidence }) => ({
        eventId,
        runId,
        ...(turnEvidence === undefined ? {} : { turnEvidence }),
        ...(sourceRef === undefined ? {} : { sourceRef }),
        ...(dependencies === undefined ? {} : { dependencies }),
      })),
    )
  );
}

export function mappingScope(job: ReconstructionJob): CaptureScope {
  const eventId = `${RECONSTRUCTION_MAPPING_EVENT_ID_PREFIX}${identifierHash(canonicalJson(scopeOf(job)))}`;
  return { ...scopeOf(job), eventId };
}
