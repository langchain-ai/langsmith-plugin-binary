import {
  prepareCodingAgentMetadataProvenance,
  type CodingAgentIntegration,
} from "../../metadata/index.js";
import type { JsonValue } from "../../storage/capture/models.js";
import {
  canonicalJsonValue,
  ownDataField,
  requireNonBlankString,
  requireOwnDataField,
  requirePlainRecord,
  requireStringArray,
} from "../../utils/validation/objects.js";
import { normalizedRedactedFields } from "../upload/redaction.js";
import type { NormalizedRunContext } from "../upload/models.js";
import type {
  LifecycleTurnEvidence,
  ProjectedSubmission,
  SubmissionProjectionResult,
} from "./models.js";
import { LIFECYCLE_ATTRIBUTION_READY_FIELD, LIFECYCLE_TURN_CLOSURE_STATES } from "./constants.js";
import {
  canonicalIdentity,
  normalizedPatch,
  normalizedRunContext,
  normalizedRunSnapshot,
  privacyStatus,
  statusForPost,
} from "./utils/validation.js";
import { projectPatch, projectPost } from "./privacy-projection.js";

export function projectSubmission(
  value: unknown,
  integration: CodingAgentIntegration,
  priorIdentity?: NormalizedRunContext,
): SubmissionProjectionResult {
  const source = requirePlainRecord(value, "Prepared run submission");
  if (requireOwnDataField(source, "integration") !== integration) {
    throw new TypeError("Run integration does not match the lifecycle bridge");
  }
  const privacyMode = requireOwnDataField(source, "privacyMode");
  if (privacyMode !== "full" && privacyMode !== "metadata")
    throw new TypeError("Invalid privacy mode");
  const redactedField = ownDataField(source, "redactedFields");
  const redactedFields = normalizedRedactedFields(
    redactedField.present ? redactedField.value : undefined,
  );
  const redaction = privacyMode === "full" && redactedFields.length > 0 ? { redactedFields } : {};
  const operation = requireOwnDataField(source, "operation");
  if (operation !== "post" && operation !== "patch") throw new TypeError("Invalid run operation");

  if (operation === "post") {
    const run = canonicalIdentity(
      normalizedRunSnapshot(requireOwnDataField(source, "run")),
      priorIdentity,
    );
    const suppliedPrivacyContext = ownDataField(source, "privacyContext");
    const status =
      run.error !== undefined
        ? "error"
        : suppliedPrivacyContext.present
          ? privacyStatus(suppliedPrivacyContext.value).status
          : statusForPost(run);
    const metadata = prepareCodingAgentMetadataProvenance(
      requireOwnDataField(source, "metadata"),
      integration,
      privacyMode,
      status,
    );
    if (metadata.status === "deferred") return metadata;
    const projected: ProjectedSubmission = {
      payload: {
        operation,
        integration,
        privacyMode,
        ...redaction,
        ...(privacyMode === "metadata" ? { privacyContext: { status } } : {}),
        run: privacyMode === "metadata" ? projectPost(run, metadata.value, status) : run,
      },
      metadata: metadata.value,
      privacyStatus: status,
    };
    return { status: "ready", value: projected };
  }

  const run = canonicalIdentity(
    normalizedRunContext(requireOwnDataField(source, "run")),
    priorIdentity,
    true,
  );
  const patch = normalizedPatch(requireOwnDataField(source, "patch"));
  const privacyContext = privacyStatus(requireOwnDataField(source, "privacyContext"));
  const metadata = prepareCodingAgentMetadataProvenance(
    requireOwnDataField(source, "metadata"),
    integration,
    privacyMode,
    privacyContext.status,
  );
  if (metadata.status === "deferred") return metadata;
  const projected: ProjectedSubmission = {
    payload: {
      operation,
      integration,
      privacyMode,
      ...redaction,
      run,
      privacyContext,
      patch:
        privacyMode === "metadata"
          ? projectPatch(run, patch, integration, metadata.value, privacyContext)
          : patch,
    },
    metadata: metadata.value,
    privacyStatus: privacyContext.status,
  };
  return { status: "ready", value: projected };
}

export function projectTurnEvidence(
  value: unknown,
  mode: "full" | "metadata",
  attributionReady: boolean,
): JsonValue {
  const source = requirePlainRecord(value, "Lifecycle turn evidence");
  const childRunIds = requireStringArray(
    requireOwnDataField(source, "childRunIds"),
    "Child run IDs",
  ).map((runId) => requireNonBlankString(runId, "Child run ID"));
  const closureState = requireOwnDataField(source, "closureState");
  if (
    typeof closureState !== "string" ||
    !LIFECYCLE_TURN_CLOSURE_STATES.includes(closureState as LifecycleTurnEvidence["closureState"])
  ) {
    throw new TypeError("Lifecycle turn evidence has an invalid closure state");
  }
  const structural: LifecycleTurnEvidence = {
    childRunIds,
    closureState: closureState as LifecycleTurnEvidence["closureState"],
  };
  const persisted = { ...structural, [LIFECYCLE_ATTRIBUTION_READY_FIELD]: attributionReady };
  const rootRunId = ownDataField(source, "rootRunId");
  if (rootRunId.present && rootRunId.value !== undefined) {
    persisted.rootRunId = requireNonBlankString(rootRunId.value, "Root run ID");
  }
  return canonicalJsonValue(mode === "metadata" ? persisted : { ...source, ...persisted });
}
