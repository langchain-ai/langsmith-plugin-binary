import { credentialHash } from "../../auth/profile.js";
import { LOGIN_EXPIRED_STATUS, LOGIN_NO_ACCESS_STATUS } from "../../auth/expiry-constants.js";
import {
  clearLoginExpiry,
  clearRejectedKey,
  recordExpiredLogin,
  recordRejectedKey,
} from "../../auth/expiry.js";
import { buildCodingAgentMetadata } from "../../metadata/index.js";
import { fillTemplate } from "../../utils/format.js";
import { createCodingAgentRunTree } from "../../privacy/index.js";
import type { Client, RunTreeConfig } from "langsmith";
import type { RunCreate, RunUpdate } from "langsmith/schemas";
import type { CaptureDestinationRoute } from "../../storage/capture/models.js";
import type {
  LangSmithUploadWriter,
  LangSmithUploadWriterOptions,
  NormalizedRunContext,
  NormalizedRunPatchField,
  PreparedRunPatchSubmission,
  PreparedRunPostSubmission,
  PreparedRunSubmission,
  ResolvedUploadDestination,
  UploadBatchItem,
  PreparedUploadItem,
  UploadClientCache,
  UploadIngest,
  UploadReceipt,
} from "./models.js";
import { resolveUploadDestinations } from "./destinations.js";
import {
  UPLOAD_AGENT_ADDRESS,
  UPLOAD_BATCH_LIMITS,
  UPLOAD_PATCH_FIELDS,
  UPLOAD_RECEIPT_MISSING_MESSAGE,
  UPLOAD_UNKNOWN_DESTINATION_MESSAGE,
} from "./constants.js";
import { createUploadClientCache } from "./client-cache.js";
import { takeRejectedAccessToken } from "./client.js";
import { UploadError, isAlreadyReceived } from "./errors.js";
import { redactSdkOmittedFields } from "./redaction.js";
import { applyRuntimeMetadata } from "./runtime-metadata.js";
import { contextForDestination, runIdForDestination } from "./replica-identifiers.js";
import { applyReplicaPatchUpdates } from "./replica-updates.js";
import { withDeadline } from "./deadline.js";
import { isSampled, samplingRate } from "./sampling.js";
import { startTimeText } from "./timestamps.js";

export function createLangSmithUploadWriter(
  options: LangSmithUploadWriterOptions,
): LangSmithUploadWriter {
  const resolved = resolveUploadDestinations(options);
  const destinations = resolved.destinations.map(({ id }) => Object.freeze({ id }));
  const byId = new Map(resolved.destinations.map((destination) => [destination.id, destination]));
  const clients = createUploadClientCache();
  const rate = samplingRate(process.env);
  const routes = Object.freeze(
    Object.fromEntries(
      resolved.destinations.map(({ id, projectName, agentId, sourceProjectName }) => [
        id,
        Object.freeze({
          projectName,
          ...(agentId === undefined ? {} : { agentId }),
          ...(sourceProjectName === undefined ? {} : { sourceProjectName }),
        }),
      ]),
    ),
  );

  async function sendBatch(
    items: readonly UploadBatchItem[],
    destinationId: string,
  ): Promise<UploadReceipt[]> {
    const configured = byId.get(destinationId);
    if (!configured) throw new TypeError(UPLOAD_UNKNOWN_DESTINATION_MESSAGE);
    const prepared = items.map(({ submission, route }) =>
      prepareItem(
        clients,
        route === undefined || options.projectLocked
          ? configured
          : routedDestination(configured, route),
        submission,
      ),
    );
    const clientOptions = {
      apiUrl: configured.apiUrl,
      ...(configured.workspaceId === undefined ? {} : { workspaceId: configured.workspaceId }),
    };
    let uploaded = false;
    for (const [client, group] of segmentByClient(prepared)) {
      const sampled = group.filter((item) => isSampled(item, rate));
      try {
        await withDeadline(client.batchIngestRuns(ingestFor(sampled), clientOptions)).catch(
          ignoreAlreadyReceived,
        );
        uploaded ||= sampled.length > 0;
      } catch (error) {
        const failure = new UploadError(error, configured.login !== undefined);
        const sent = takeRejectedAccessToken(client);
        const denied = failure.status === LOGIN_NO_ACCESS_STATUS;
        if ((failure.loginRejected || denied) && configured.login !== undefined)
          void recordExpiredLogin(
            configured.login,
            sent && credentialHash(sent),
            options.storageRoot,
            denied,
          );
        if (configured.apiKey !== undefined && (failure.status === LOGIN_EXPIRED_STATUS || denied))
          void recordRejectedKey(
            { apiKey: configured.apiKey, apiUrl: configured.apiUrl },
            options.storageRoot,
            denied,
          );
        throw failure;
      }
    }
    if (uploaded && configured.login !== undefined) {
      void clearLoginExpiry(configured.login, options.storageRoot);
      void clearRejectedKey(options.storageRoot);
    } else if (uploaded && configured.apiKey !== undefined)
      void clearRejectedKey(options.storageRoot, {
        apiKey: configured.apiKey,
        apiUrl: configured.apiUrl,
      });
    return prepared.map(({ submission, operation }) => ({
      destinationId,
      runId: submission.run.id,
      operation,
    }));
  }

  return Object.freeze({
    accountFingerprint: resolved.accountFingerprint,
    destinations: Object.freeze(destinations),
    routes,
    batchLimits: UPLOAD_BATCH_LIMITS,
    sendBatch,
    async send(
      submission: PreparedRunSubmission,
      destinationId: string,
      route?: CaptureDestinationRoute,
    ): Promise<UploadReceipt> {
      const [receipt] = await sendBatch(
        [route === undefined ? { submission } : { submission, route }],
        destinationId,
      );
      if (receipt === undefined) throw new Error(UPLOAD_RECEIPT_MISSING_MESSAGE);
      return receipt;
    },
  });
}

function routedDestination(
  destination: ResolvedUploadDestination,
  route: CaptureDestinationRoute,
): ResolvedUploadDestination {
  const routed: ResolvedUploadDestination = { ...destination, projectName: route.projectName };
  if (route.agentId === undefined) delete routed.agentId;
  else routed.agentId = route.agentId;
  if (route.sourceProjectName === undefined) delete routed.sourceProjectName;
  else routed.sourceProjectName = route.sourceProjectName;
  return routed;
}

function prepareItem(
  clients: UploadClientCache,
  destination: ResolvedUploadDestination,
  submission: PreparedRunSubmission,
): PreparedUploadItem {
  validateSubmission(submission);
  const client = clients.forSubmission(destination, submission);
  const payload =
    submission.operation === "post"
      ? preparePostRunPayload(submission, destination)
      : preparePatchRunPayload(submission, destination);
  if (submission.operation === "patch") {
    applyReplicaPatchUpdates(payload, destination, submission.privacyMode);
  }
  applyRuntimeMetadata(payload, submission.privacyMode);
  redactSdkOmittedFields(payload, destination.anonymizer);
  return {
    client,
    submission,
    payload,
    destination,
    operation: submission.operation === "post" ? "posted" : "patched",
  };
}

function segmentByClient(items: readonly PreparedUploadItem[]): [Client, PreparedUploadItem[]][] {
  const segments: [Client, PreparedUploadItem[]][] = [];
  for (const item of items) {
    const last = segments.at(-1);
    if (last !== undefined && last[0] === item.client) last[1].push(item);
    else segments.push([item.client, [item]]);
  }
  return segments;
}

function ingestFor(items: readonly PreparedUploadItem[]): UploadIngest {
  const runCreates: RunCreate[] = [];
  const runUpdates: RunUpdate[] = [];
  for (const { payload, submission, destination, operation } of items) {
    if (operation === "posted") {
      runCreates.push(withTarget(payload as RunCreate, destination));
    } else {
      const id = runIdForDestination(submission.run.id, destination);
      runUpdates.push(withTarget({ ...payload, id } as RunUpdate, destination));
    }
  }
  return { runCreates, runUpdates };
}

function withTarget<T extends RunCreate | RunUpdate>(
  payload: T,
  destination: ResolvedUploadDestination,
): T {
  if (destination.agentId === undefined)
    return { ...payload, session_name: destination.projectName };
  const { session_name: _project, ...rest } = payload as RunCreate;
  const address = fillTemplate(UPLOAD_AGENT_ADDRESS, { agentId: destination.agentId });
  return { ...rest, address } as unknown as T;
}

function ignoreAlreadyReceived(error: unknown): void {
  if (!isAlreadyReceived(error)) throw error;
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
  const create = JSON.parse(JSON.stringify(run.toJSON())) as RunCreate;
  const startTime = startTimeText(source.start_time, create.dotted_order);
  if (startTime !== undefined) create.start_time = startTime;
  return create;
}

function preparePatchRunPayload(
  submission: PreparedRunPatchSubmission,
  destination: ResolvedUploadDestination,
): RunUpdate {
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
    trace_id: snapshot["trace_id"],
    dotted_order: snapshot["dotted_order"],
    ...(snapshot["parent_run_id"] === undefined
      ? {}
      : { parent_run_id: snapshot["parent_run_id"] }),
  } as RunUpdate;
  for (const field of submission.patch.fields) {
    const value = snapshot[field];
    if (value === undefined) continue;
    if (field === "inputs") update.inputs = value as NonNullable<RunUpdate["inputs"]>;
    else if (field === "outputs") update.outputs = value as NonNullable<RunUpdate["outputs"]>;
    else if (field === "end_time") update.end_time = value as NonNullable<RunUpdate["end_time"]>;
    else if (field === "error") update.error = value as NonNullable<RunUpdate["error"]>;
    else if (field === "tags") update.tags = value as NonNullable<RunUpdate["tags"]>;
    else if (field === "serialized")
      update.serialized = value as NonNullable<RunUpdate["serialized"]>;
    else if (field === "events") update.events = value as NonNullable<RunUpdate["events"]>;
    else if (field === "reference_example_id") {
      update.reference_example_id = value as NonNullable<RunUpdate["reference_example_id"]>;
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
