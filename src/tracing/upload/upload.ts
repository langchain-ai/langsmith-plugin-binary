import { buildCodingAgentMetadata } from "../../metadata/index.js";
import { createCodingAgentRunTree } from "../../privacy/index.js";
import type { Client, RunTreeConfig } from "langsmith";
import type {
  LangSmithRunCreate,
  LangSmithUploadWriter,
  LangSmithUploadWriterOptions,
  NormalizedRunSnapshot,
  PreparedRunPostSubmission,
  ResolvedUploadDestination,
  UploadReceipt,
} from "./models.js";
import { resolveUploadDestinations } from "./destinations.js";
import { createUploadClient } from "./client.js";
import { normalizedRedactedFields, redactSdkOmittedFields } from "./redaction.js";

export function createLangSmithUploadWriter(
  options: LangSmithUploadWriterOptions,
): LangSmithUploadWriter {
  const resolved = resolveUploadDestinations(options);
  const destinations = resolved.destinations.map(({ id }) => Object.freeze({ id }));
  const byId = new Map(resolved.destinations.map((destination) => [destination.id, destination]));
  const redactedClients = new Map<string, Client>();
  return Object.freeze({
    accountFingerprint: resolved.accountFingerprint,
    destinations: Object.freeze(destinations),
    async send(
      submission: PreparedRunPostSubmission,
      destinationId: string,
    ): Promise<UploadReceipt> {
      const destination = byId.get(destinationId);
      if (!destination) throw new TypeError("Unknown upload destination");
      validateSubmission(submission);
      const normalizedFields = normalizedRedactedFields(submission.redactedFields);
      const redactedFields = submission.privacyMode === "full" ? normalizedFields : [];
      let client = destination.client;
      if (redactedFields.length > 0) {
        const key = JSON.stringify([destinationId, redactedFields]);
        const previous = redactedClients.get(key);
        client = previous ?? createUploadClient({ ...destination, redactedFields });
        if (previous === undefined) redactedClients.set(key, client);
      }
      const payload = preparePostRunPayload(submission, destination);
      redactSdkOmittedFields(payload, destination.anonymizer);
      const clientOptions = {
        apiKey: destination.apiKey,
        apiUrl: destination.apiUrl,
        ...(destination.workspaceId === undefined ? {} : { workspaceId: destination.workspaceId }),
      };
      try {
        await client.createRun(
          { ...payload, project_name: destination.projectName } as LangSmithRunCreate,
          clientOptions,
        );
        return { destinationId, runId: submission.run.id, operation: "posted" };
      } catch {
        throw new Error("LangSmith upload failed");
      }
    },
  });
}

function runConfig(
  context: NormalizedRunSnapshot,
  submission: PreparedRunPostSubmission,
  destination: ResolvedUploadDestination,
): RunTreeConfig {
  const metadata = buildCodingAgentMetadata(submission.metadata);
  return {
    id: context.id,
    name: context.name,
    run_type: context.run_type,
    project_name: destination.projectName,
    inputs: {},
    extra: { metadata },
    client: destination.client,
    ...(context.start_time === undefined ? {} : { start_time: context.start_time }),
    ...(context.parent_run_id === undefined ? {} : { parent_run_id: context.parent_run_id }),
    ...(context.trace_id === undefined ? {} : { trace_id: context.trace_id }),
    ...(context.dotted_order === undefined ? {} : { dotted_order: context.dotted_order }),
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

function validateSubmission(submission: PreparedRunPostSubmission): void {
  if (submission === null || typeof submission !== "object") {
    throw new TypeError("A prepared run submission is required");
  }
  if (submission.operation !== "post") throw new TypeError("Invalid upload operation");
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
}
