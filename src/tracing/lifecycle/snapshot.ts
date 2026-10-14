import { join } from "node:path";
import { withFileLock } from "../../storage/index.js";
import { identifierHash, validateIdentifier } from "../../storage/capture/paths.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import {
  canonicalJsonValue,
  requireNonBlankString,
  requireOwnDataField,
  requirePlainRecord,
} from "../../utils/validation/objects.js";
import { snapshotData } from "../../utils/validation/snapshot.js";
import { normalizedRedactedFields } from "../upload/redaction.js";
import {
  LIFECYCLE_SNAPSHOT_LOCK_DIRECTORY,
  LIFECYCLE_SNAPSHOT_LOCK_FILE,
  LIFECYCLE_SNAPSHOT_REVISION_EVENT_ID_PREFIX,
} from "./constants.js";
import type { PreparedRunPatchSubmission } from "../upload/models.js";
import type {
  LifecycleCaptureResult,
  LifecycleCaptureInput,
  LifecycleSnapshotCaptureInput,
  LifecycleSnapshotCaptureOptions,
} from "./models.js";
import { deriveAttributionReadiness } from "./closure.js";
import { projectSubmission, projectTurnEvidence } from "./projection.js";
import { wakeCapturedWork } from "../capture-wake.js";
import { statusForPost as runPrivacyStatus } from "./utils/validation.js";
import { readSnapshotState } from "./snapshot-state.js";
import {
  applySnapshotOmissions,
  captureScope,
  runContext,
  sameCanonical,
  sameRunIdentity,
  snapshotPatchFields,
  snapshotPatchValues,
} from "./utils/snapshot-values.js";

export async function captureLifecycleSnapshot(
  options: LifecycleSnapshotCaptureOptions,
  input: LifecycleSnapshotCaptureInput,
): Promise<LifecycleCaptureResult> {
  const captureInput = snapshotData(
    requirePlainRecord(input, "Lifecycle snapshot capture"),
  ) as unknown as LifecycleSnapshotCaptureInput;
  const snapshot = requirePlainRecord(captureInput, "Lifecycle snapshot capture");
  const turnId = requireNonBlankString(snapshot["turnId"], "Turn ID");
  const eventId = requireNonBlankString(snapshot["eventId"], "Event ID");
  validateIdentifier(turnId, "turn ID");
  validateIdentifier(eventId, "event ID");
  const submission = requirePlainRecord(snapshot["submission"], "Prepared run snapshot");
  if (submission["operation"] !== "post") throw new TypeError("A full run snapshot must be a POST");
  const sourceRun = requirePlainRecord(requireOwnDataField(submission, "run"), "Run snapshot");
  const runId = requireNonBlankString(requireOwnDataField(sourceRun, "id"), "Run ID");
  validateIdentifier(runId, "run ID");
  const streamHash = identifierHash(
    `${options.integration}\0${options.sessionId}\0${turnId}\0${runId}`,
  );
  const revisionPrefix = `${LIFECYCLE_SNAPSHOT_REVISION_EVENT_ID_PREFIX}${streamHash}:`;
  return withLifecycleSnapshotLock(options, turnId, runId, async () => {
    const records = (
      await options.store.enumerateTurn(options.integration, options.sessionId, turnId)
    )
      .map(({ record }) => record)
      .filter((record) => record.runId === runId);
    const state = readSnapshotState(records, options.destinationFingerprint, revisionPrefix);
    if (state === "conflict") return { status: "conflict" };
    if (state === undefined) {
      if (records.length > 0) return { status: "conflict" };
      return options.capture(captureInput);
    }
    if (state.post.destinationFingerprint !== options.destinationFingerprint) {
      return { status: "conflict" };
    }
    const projected = projectSubmission(
      snapshot["submission"],
      options.integration,
      runContext(state.post),
    );
    if (projected.status === "deferred") {
      return { status: "deferred", reason: "missing-thread-identity" };
    }
    if (projected.value.payload.operation !== "post") return { status: "conflict" };
    if (
      projected.value.payload.privacyMode !== state.privacyMode ||
      !sameCanonical(
        normalizedRedactedFields(projected.value.payload.redactedFields),
        state.redactedFields,
      )
    ) {
      return { status: "conflict" };
    }
    const candidateRun = applySnapshotOmissions(projected.value.payload.run, state.run, sourceRun);
    if (!sameRunIdentity(state.run, candidateRun)) return { status: "conflict" };
    const privacyStatus =
      state.privacyMode === "metadata"
        ? projected.value.privacyStatus
        : runPrivacyStatus(candidateRun);
    const evidence = projectTurnEvidence(
      snapshot["turnEvidence"],
      state.privacyMode,
      deriveAttributionReadiness(snapshot["submission"], options.integration),
    );
    const metadata = canonicalJsonValue(projected.value.metadata);
    const changedFields = snapshotPatchFields(
      state.run,
      candidateRun,
      state.inputOutputStates,
      sourceRun,
    );
    const newDependencies = (captureInput.dependencies ?? []).some(
      (dependency) =>
        !sameCanonical(dependency, captureScope(state.head)) &&
        !state.snapshotDependencies.some((persisted) => sameCanonical(dependency, persisted)),
    );
    if (
      changedFields.length === 0 &&
      sameCanonical(state.metadataProvenance, metadata) &&
      sameCanonical(state.turnEvidence, evidence) &&
      state.privacyStatus === privacyStatus &&
      !newDependencies
    ) {
      const result = { status: "duplicate" as const, record: state.head };
      await wakeCapturedWork(result, options.wake);
      return result;
    }
    const patchValues = snapshotPatchValues(sourceRun, changedFields);
    if (patchValues === undefined) return { status: "conflict" };
    const patch: PreparedRunPatchSubmission = {
      operation: "patch",
      integration: options.integration,
      privacyMode: state.privacyMode,
      ...(submission["redactedFields"] === undefined
        ? {}
        : { redactedFields: normalizedRedactedFields(submission["redactedFields"]) }),
      metadata: captureInput.submission.metadata,
      run: runContext(state.post),
      privacyContext: { status: privacyStatus },
      patch: { fields: changedFields, values: patchValues },
    };
    const nextRevision = state.revisionCount + 1;
    const revisionInput: LifecycleCaptureInput = {
      turnId,
      eventId: `${revisionPrefix}${String(nextRevision).padStart(12, "0")}`,
      submission: patch,
      turnEvidence: captureInput.turnEvidence,
      dependencies: [
        captureScope(state.head),
        ...(captureInput.dependencies ?? []).filter(
          (dependency) => !sameCanonical(dependency, captureScope(state.head)),
        ),
      ],
      sourceAgeStartedAtMs: state.post.sourceAgeStartedAtMs ?? state.post.capturedAtMs,
    };
    return options.capture(revisionInput);
  });
}

export async function withLifecycleSnapshotLock<T>(
  options: Pick<LifecycleSnapshotCaptureOptions, "storageRoot" | "integration" | "sessionId">,
  turnId: string,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  validateIdentifier(turnId, "turn ID");
  validateIdentifier(runId, "run ID");
  const lockDirectory = await ensurePrivateDirectory(options.storageRoot, [
    LIFECYCLE_SNAPSHOT_LOCK_DIRECTORY,
    "integrations",
    options.integration,
    "sessions",
    identifierHash(options.sessionId),
    "turns",
    identifierHash(turnId),
    "runs",
    identifierHash(runId),
  ]);
  return withFileLock(join(lockDirectory, LIFECYCLE_SNAPSHOT_LOCK_FILE), operation);
}
