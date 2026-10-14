import type { StoredCapture } from "../../storage/capture/models.js";
import {
  canonicalJsonValue,
  requireOwnDataField,
  requirePlainRecord,
  requireStringArray,
} from "../../utils/validation/objects.js";
import type { NormalizedRunSnapshot, RedactedRunField } from "../upload/models.js";
import type { LifecycleSnapshotState } from "./models.js";
import {
  LIFECYCLE_SNAPSHOT_CONTENT_FIELDS,
  LIFECYCLE_PATCH_EVENT_KIND,
  LIFECYCLE_POST_EVENT_KIND,
  LIFECYCLE_SETTLEMENT_EVENT_KIND,
} from "./constants.js";
import { SETTLEMENT_EVENT_ID_PATTERN } from "../settlement/constants.js";
import {
  captureScope,
  payloadObject,
  presentFieldState,
  readPrivacyMode,
  readPrivacyStatus,
  sameCanonical,
  sameRunIdentity,
  storedPrivacyStatus,
  storedRedactedFields,
  storedRun,
  readStoredPatchValues,
} from "./utils/snapshot-values.js";

export function readSnapshotState(
  records: readonly StoredCapture[],
  destinationFingerprint: string,
  revisionPrefix: string,
): LifecycleSnapshotState | "conflict" | undefined {
  const posts = records.filter((record) => record.eventKind === LIFECYCLE_POST_EVENT_KIND);
  const revisionCandidates = records.filter((record) => record.eventId.startsWith(revisionPrefix));
  if (posts.length > 1) return "conflict";
  const post = posts[0];
  if (post === undefined) return records.length === 0 ? undefined : "conflict";
  if (
    post.destinationFingerprint !== destinationFingerprint ||
    payloadObject(post)["operation"] !== "post"
  ) {
    return "conflict";
  }
  const postPayload = payloadObject(post);
  const privacyMode = readPrivacyMode(postPayload);
  const run = storedRun(postPayload, post.runId);
  const runFields = run as unknown as Record<string, unknown>;
  const inputOutputStates = post.compaction?.fields ?? {
    inputs: presentFieldState(runFields, "inputs"),
    outputs: presentFieldState(runFields, "outputs"),
  };
  const redactedFields = storedRedactedFields(postPayload);
  let metadataProvenance = canonicalJsonValue(post.metadataProvenance);
  let turnEvidence = canonicalJsonValue(post.turnEvidence);
  let privacyStatus = storedPrivacyStatus(postPayload, run, privacyMode);
  let head = post;
  const orderedRevisions = revisionCandidates.toSorted((left, right) =>
    left.eventId.localeCompare(right.eventId),
  );
  for (let index = 0; index < orderedRevisions.length; index += 1) {
    const revision = orderedRevisions[index]!;
    const expectedId = `${revisionPrefix}${String(index + 1).padStart(12, "0")}`;
    if (
      revision.eventId !== expectedId ||
      revision.eventKind !== LIFECYCLE_PATCH_EVENT_KIND ||
      revision.destinationFingerprint !== destinationFingerprint ||
      !(revision.dependencies ?? []).some((dependency) =>
        sameCanonical(dependency, captureScope(head)),
      )
    ) {
      return "conflict";
    }
    const payload = payloadObject(revision);
    if (readPrivacyMode(payload) !== privacyMode) return "conflict";
    if (!sameCanonical(storedRedactedFields(payload), redactedFields)) return "conflict";
    const patch = requirePlainRecord(requireOwnDataField(payload, "patch"), "Stored run patch");
    const values = requirePlainRecord(requireOwnDataField(patch, "values"), "Stored patch values");
    const fields = requireStringArray(requireOwnDataField(patch, "fields"), "Stored patch fields");
    const selectedValues = readStoredPatchValues(fields, values);
    if (selectedValues === undefined) return "conflict";
    Object.assign(runFields, selectedValues);
    for (const field of LIFECYCLE_SNAPSHOT_CONTENT_FIELDS) {
      const compactedField = revision.compaction?.fields[field];
      if (compactedField?.state === "value") {
        delete runFields[field];
        inputOutputStates[field] = compactedField;
      } else if (fields.includes(field)) {
        inputOutputStates[field] = { state: "preserve" };
      }
    }
    const runContextValue = requirePlainRecord(
      requireOwnDataField(payload, "run"),
      "Stored run context",
    );
    if (!sameRunIdentity(run, runContextValue as unknown as NormalizedRunSnapshot))
      return "conflict";
    privacyStatus = readPrivacyStatus(requireOwnDataField(payload, "privacyContext"));
    metadataProvenance = canonicalJsonValue(revision.metadataProvenance);
    turnEvidence = canonicalJsonValue(revision.turnEvidence);
    head = revision;
  }
  const snapshotChain = [post, ...orderedRevisions];
  for (const record of records) {
    if (snapshotChain.includes(record)) continue;
    if (
      record.eventKind !== LIFECYCLE_SETTLEMENT_EVENT_KIND ||
      !SETTLEMENT_EVENT_ID_PATTERN.test(record.eventId) ||
      record.destinationFingerprint !== destinationFingerprint ||
      !validSettlementRecord(record, run, privacyMode, redactedFields, snapshotChain)
    ) {
      return "conflict";
    }
  }
  return {
    post,
    head,
    run,
    metadataProvenance,
    turnEvidence,
    privacyMode,
    redactedFields,
    inputOutputStates,
    privacyStatus,
    revisionCount: orderedRevisions.length,
    snapshotDependencies: snapshotChain.flatMap((record) => record.dependencies ?? []),
  };
}

function validSettlementRecord(
  record: StoredCapture,
  currentRun: NormalizedRunSnapshot,
  privacyMode: "full" | "metadata",
  redactedFields: readonly RedactedRunField[],
  snapshotChain: readonly StoredCapture[],
): boolean {
  const payload = payloadObject(record);
  if (payloadObject(record)["operation"] !== "patch" || readPrivacyMode(payload) !== privacyMode)
    return false;
  if (!sameCanonical(storedRedactedFields(payload), redactedFields)) return false;
  readPrivacyStatus(requireOwnDataField(payload, "privacyContext"));
  const run = requirePlainRecord(requireOwnDataField(payload, "run"), "Settlement run context");
  if (!sameRunIdentity(currentRun, run as unknown as NormalizedRunSnapshot)) return false;
  const patch = requirePlainRecord(requireOwnDataField(payload, "patch"), "Settlement run patch");
  const fields = requireStringArray(
    requireOwnDataField(patch, "fields"),
    "Settlement patch fields",
  );
  const values = requirePlainRecord(
    requireOwnDataField(patch, "values"),
    "Settlement patch values",
  );
  if (readStoredPatchValues(fields, values) === undefined) return false;
  return (record.dependencies ?? []).some((dependency) =>
    snapshotChain.some((source) => sameCanonical(dependency, captureScope(source))),
  );
}
