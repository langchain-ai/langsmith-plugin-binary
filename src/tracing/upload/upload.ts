import { buildCodingAgentMetadata } from "../../metadata/index.js";
import { createCodingAgentRunTree } from "../../privacy/index.js";
import { isPlainRecord } from "../../utils/validation/objects.js";
import type { RunTreeConfig } from "langsmith";
import type {
  LangSmithRunUpdate,
  LangSmithRunCreate,
  LangSmithUploadWriter,
  LangSmithUploadWriterOptions,
  NormalizedRunContext,
  NormalizedRunPatchField,
  PreparedRunPatchSubmission,
  PreparedRunPostSubmission,
  PreparedRunSubmission,
  ResolvedUploadDestination,
  UploadReceipt,
} from "./models.js";
import { resolveUploadDestinations } from "./destinations.js";
import { UPLOAD_PATCH_FIELDS } from "./constants.js";
import { redactSdkOmittedFields } from "./redaction.js";
import { remapReplicaRunContext, remapReplicaRunId } from "./replica-identifiers.js";

export function createLangSmithUploadWriter(
  options: LangSmithUploadWriterOptions,
): LangSmithUploadWriter {
  const resolved = resolveUploadDestinations(options);
  const destinations = resolved.destinations.map(({ id }) => Object.freeze({ id }));
  const byId = new Map(resolved.destinations.map((destination) => [destination.id, destination]));
  return Object.freeze({
    accountFingerprint: resolved.accountFingerprint,
    destinations: Object.freeze(destinations),
    async send(submission: PreparedRunSubmission, destinationId: string): Promise<UploadReceipt> {
      const destination = byId.get(destinationId);
      if (!destination) throw new TypeError("Unknown upload destination");
      validateSubmission(submission);
      const payload =
        submission.operation === "post"
          ? preparePostRunPayload(submission, destination)
          : preparePatchRunPayload(submission, destination);
      if (submission.operation === "patch") {
        applyReplicaPatchUpdates(payload, destination, submission.privacyMode);
      }
      redactSdkOmittedFields(payload, destination.anonymizer);
      const clientOptions = {
        apiKey: destination.apiKey,
        apiUrl: destination.apiUrl,
        ...(destination.workspaceId === undefined ? {} : { workspaceId: destination.workspaceId }),
      };
      try {
        if (submission.operation === "post") {
          await destination.client.createRun(
            { ...payload, project_name: destination.projectName } as LangSmithRunCreate,
            clientOptions,
          );
          return { destinationId, runId: submission.run.id, operation: "posted" };
        }
        await destination.client.updateRun(
          runIdForDestination(submission.run.id, destination),
          payload,
          clientOptions,
        );
        return { destinationId, runId: submission.run.id, operation: "patched" };
      } catch {
        throw new Error("LangSmith upload failed");
      }
    },
  });
}

function runConfig(
  context: NormalizedRunContext,
  submission: PreparedRunSubmission,
  destination: ResolvedUploadDestination,
): RunTreeConfig {
  const metadata = buildCodingAgentMetadata(submission.metadata);
  const destinationContext = contextForDestination(context, destination);
  return {
    id: destinationContext.id,
    name: destinationContext.name,
    run_type: destinationContext.run_type,
    project_name: destination.projectName,
    inputs: {},
    extra: { metadata },
    client: destination.client,
    ...(destinationContext.start_time === undefined
      ? {}
      : { start_time: destinationContext.start_time }),
    ...(destinationContext.parent_run_id === undefined
      ? {}
      : { parent_run_id: destinationContext.parent_run_id }),
    ...(destinationContext.trace_id === undefined ? {} : { trace_id: destinationContext.trace_id }),
    ...(destinationContext.dotted_order === undefined
      ? {}
      : { dotted_order: destinationContext.dotted_order }),
  };
}

function contextForDestination(
  context: NormalizedRunContext,
  destination: ResolvedUploadDestination,
): NormalizedRunContext {
  if (destination.sourceProjectName === undefined) return context;
  return remapReplicaRunContext(context, destination.sourceProjectName, destination.projectName);
}

function runIdForDestination(runId: string, destination: ResolvedUploadDestination): string {
  if (
    destination.sourceProjectName === undefined ||
    destination.sourceProjectName === destination.projectName
  ) {
    return runId;
  }
  return remapReplicaRunId(runId, destination.projectName);
}

function applyReplicaPatchUpdates(
  payload: LangSmithRunUpdate,
  destination: ResolvedUploadDestination,
  privacyMode: PreparedRunSubmission["privacyMode"],
): void {
  if (privacyMode !== "full" || destination.updates === undefined) return;
  const mutablePayload = payload as Record<string, unknown>;
  for (const [field, value] of Object.entries(destination.updates)) {
    if (field === "inputs") continue;
    if (field === "extra") {
      mutablePayload.extra = mergeReplicaExtra(mutablePayload.extra, value);
    } else {
      mutablePayload[field] = structuredClone(value);
    }
  }
}

function mergeReplicaExtra(baseValue: unknown, updateValue: unknown): Record<string, unknown> {
  const baseExtra = isPlainRecord(baseValue) ? baseValue : {};
  const updateExtra = isPlainRecord(updateValue) ? structuredClone(updateValue) : {};
  const baseMetadata = isPlainRecord(baseExtra["metadata"]) ? baseExtra["metadata"] : {};
  const updateMetadata = isPlainRecord(updateExtra["metadata"]) ? updateExtra["metadata"] : {};
  return {
    ...baseExtra,
    ...updateExtra,
    metadata: { ...updateMetadata, ...baseMetadata },
  };
}

function preparePostRunPayload(
  submission: PreparedRunPostSubmission,
  destination: ResolvedUploadDestination,
) {
  const source = submission.run;
  const config = runConfig(source, submission, destination);
  config.inputs = source.inputs;
  if (source.end_time !== undefined) config.end_time = source.end_time;
  if (source.outputs !== undefined) config.outputs = source.outputs;
  if (source.tags !== undefined) config.tags = source.tags;
  if (source.error !== undefined) config.error = source.error;
  if (source.serialized !== undefined) config.serialized = source.serialized;
  if (source.reference_example_id !== undefined) {
    config.reference_example_id = source.reference_example_id;
  }
  const run = createCodingAgentRunTree(
    config,
    submission.integration,
    submission.privacyMode,
    submission.privacyContext,
  );
  if (source.events !== undefined) run.events = source.events;
  return JSON.parse(JSON.stringify(run.toJSON())) as LangSmithRunCreate;
}

function preparePatchRunPayload(
  submission: PreparedRunPatchSubmission,
  destination: ResolvedUploadDestination,
): LangSmithRunUpdate {
  const config = runConfig(submission.run, submission, destination);
  for (const field of submission.patch.fields) {
    if (field === "inputs") config.inputs = submission.patch.values.inputs!;
    else if (field === "outputs") config.outputs = submission.patch.values.outputs!;
    else if (field === "end_time") config.end_time = submission.patch.values.end_time!;
    else if (field === "error") config.error = submission.patch.values.error!;
    else if (field === "tags") config.tags = submission.patch.values.tags!;
    else if (field === "serialized") config.serialized = submission.patch.values.serialized!;
    else if (field === "reference_example_id") {
      config.reference_example_id = submission.patch.values.reference_example_id!;
    }
  }
  const run = createCodingAgentRunTree(
    config,
    submission.integration,
    submission.privacyMode,
    submission.privacyContext,
  );
  if (submission.patch.fields.includes("events")) {
    run.events = submission.patch.values.events!;
  }
  const snapshot = JSON.parse(JSON.stringify(run.toJSON())) as Record<string, unknown>;
  const update = {
    extra: snapshot["extra"],
    session_name: destination.projectName,
  } as LangSmithRunUpdate;
  for (const field of submission.patch.fields) {
    const value = snapshot[field];
    if (value === undefined) continue;
    if (field === "inputs") update.inputs = value as NonNullable<LangSmithRunUpdate["inputs"]>;
    else if (field === "outputs")
      update.outputs = value as NonNullable<LangSmithRunUpdate["outputs"]>;
    else if (field === "end_time")
      update.end_time = value as NonNullable<LangSmithRunUpdate["end_time"]>;
    else if (field === "error") update.error = value as NonNullable<LangSmithRunUpdate["error"]>;
    else if (field === "tags") update.tags = value as NonNullable<LangSmithRunUpdate["tags"]>;
    else if (field === "serialized")
      update.serialized = value as NonNullable<LangSmithRunUpdate["serialized"]>;
    else if (field === "events") update.events = value as NonNullable<LangSmithRunUpdate["events"]>;
    else if (field === "reference_example_id") {
      update.reference_example_id = value as NonNullable<
        LangSmithRunUpdate["reference_example_id"]
      >;
    }
  }
  return update;
}

function validateSubmission(submission: PreparedRunSubmission): void {
  if (submission === null || typeof submission !== "object") {
    throw new TypeError("A prepared run submission is required");
  }
  if (submission.operation !== "post" && submission.operation !== "patch") {
    throw new TypeError("Invalid upload operation");
  }
  if (submission.metadata === null || typeof submission.metadata !== "object") {
    throw new TypeError("Run metadata is required");
  }
  if (submission.integration !== submission.metadata.integration) {
    throw new TypeError("Run metadata integration does not match the submission");
  }
  if (submission.run === null || typeof submission.run !== "object") {
    throw new TypeError("Run data is required");
  }
  if (Object.hasOwn(submission.run, "child_runs")) {
    throw new TypeError("Each upload submission must contain a single run");
  }
  if (typeof submission.run.id !== "string" || submission.run.id.trim().length === 0) {
    throw new TypeError("A stable run ID is required");
  }
  if (submission.privacyMode !== "full" && submission.privacyMode !== "metadata") {
    throw new TypeError("Invalid privacy mode");
  }
  if (submission.operation === "patch") validatePatch(submission);
}

function validatePatch(submission: PreparedRunPatchSubmission): void {
  if (
    submission.patch === null ||
    typeof submission.patch !== "object" ||
    !Array.isArray(submission.patch.fields) ||
    submission.patch.values === null ||
    typeof submission.patch.values !== "object"
  ) {
    throw new TypeError("A patch field set and values are required");
  }
  if (typeof submission.run.name !== "string" || typeof submission.run.run_type !== "string") {
    throw new TypeError("Patch run context must preserve its name and type");
  }
  const selected = new Set<NormalizedRunPatchField>();
  for (const candidate of submission.patch.fields as readonly unknown[]) {
    if (
      typeof candidate !== "string" ||
      !UPLOAD_PATCH_FIELDS.has(candidate as NormalizedRunPatchField)
    ) {
      throw new TypeError("Invalid patch field");
    }
    const field = candidate as NormalizedRunPatchField;
    if (selected.has(field)) throw new TypeError("Patch fields must be unique");
    if (
      !Object.hasOwn(submission.patch.values, field) ||
      submission.patch.values[field] === undefined
    ) {
      throw new TypeError("Every selected patch field must have a value");
    }
    selected.add(field);
  }
}
