import { RunTree, type RunTreeConfig } from "langsmith";
import {
  metadataForMode,
  projectCodingAgentMetadata,
  type CodingAgentIntegration,
  type CodingAgentMetadataMode,
} from "../metadata/index.js";
import { METADATA_MODE_RUN_CONFIG_FIELDS, MUTED_TRACE_CONTENT } from "./constants.js";
import type {
  CodingAgentPrivacyContentRole,
  CodingAgentPrivacyContext,
  CodingAgentPrivacyExtra,
  CodingAgentPrivacyStatus,
  CodingAgentRunExtra,
} from "./models.js";

function mutedContent(role: CodingAgentPrivacyContentRole): Record<string, unknown> {
  return { messages: [{ role, content: MUTED_TRACE_CONTENT }] };
}

function statusOfRun(run: RunTree): CodingAgentPrivacyStatus {
  const metadataStatus = run.extra?.metadata?.status;
  if (run.error != null || metadataStatus === "error") return "error";
  if (run.end_time != null || metadataStatus === "completed") return "completed";
  return "running";
}

export function projectReplica(replica: unknown): unknown {
  if (!replica || typeof replica !== "object") return replica;
  if (Array.isArray(replica)) return { projectName: replica[0] };
  const { updates: _updates, ...safe } = replica as Record<string, unknown>;
  return safe;
}

function extraForMode(
  metadata: Record<string, unknown>,
  integration: CodingAgentIntegration,
  status: CodingAgentPrivacyStatus,
): CodingAgentPrivacyExtra {
  return {
    metadata,
    toJSON(this: CodingAgentPrivacyExtra) {
      const currentStatus = this.metadata?.status;
      const safeStatus =
        currentStatus === "running" || currentStatus === "completed" || currentStatus === "error"
          ? currentStatus
          : status;
      return {
        metadata: projectCodingAgentMetadata(this.metadata, integration, safeStatus),
      };
    },
  };
}

function configForMetadataMode(
  config: RunTreeConfig,
  integration: CodingAgentIntegration,
  privacyContext?: CodingAgentPrivacyContext,
): RunTreeConfig {
  const source = config as RunTreeConfig & Record<string, unknown>;
  const status =
    privacyContext?.status ??
    (source.error != null ? "error" : source.end_time != null ? "completed" : "running");
  const originalExtra = source.extra as CodingAgentRunExtra | undefined;
  const safe: Record<string, unknown> = {};
  for (const key of METADATA_MODE_RUN_CONFIG_FIELDS) {
    if (key in source && source[key] !== undefined) safe[key] = source[key];
  }
  if (Array.isArray(source.replicas)) safe.replicas = source.replicas.map(projectReplica);
  safe.inputs = mutedContent("user");
  safe.outputs = mutedContent("assistant");
  safe.extra = extraForMode(
    metadataForMode(originalExtra?.metadata, integration, "metadata", status) ?? {},
    integration,
    status,
  );
  return safe as unknown as RunTreeConfig;
}

function sanitizeRunTree(run: RunTree, integration: CodingAgentIntegration): void {
  const status = statusOfRun(run);
  const metadata = projectCodingAgentMetadata(run.extra?.metadata, integration, status);
  run.inputs = mutedContent("user");
  run.outputs = mutedContent("assistant");
  delete run.error;
  run.serialized = {};
  delete run.tags;
  delete run.reference_example_id;
  delete run.attachments;
  delete run.events;
  if (run.replicas) run.replicas = run.replicas.map(projectReplica) as typeof run.replicas;
  for (const child of run.child_runs ?? []) sanitizeRunTree(child, integration);
  run.extra = extraForMode(metadata, integration, status);
}

function protectRunTree(run: RunTree, integration: CodingAgentIntegration): RunTree {
  sanitizeRunTree(run, integration);

  const createChild = run.createChild.bind(run);
  run.createChild = (config) =>
    protectRunTree(createChild(configForMetadataMode(config, integration)), integration);

  const postRun = run.postRun.bind(run);
  run.postRun = async (excludeChildRuns = true) => {
    sanitizeRunTree(run, integration);
    if (!excludeChildRuns) {
      const childRuns = [...run.child_runs];
      await postRun(true);
      for (const childRun of childRuns) await childRun.postRun(false);
      return;
    }
    return postRun(excludeChildRuns);
  };

  const patchRun = run.patchRun.bind(run);
  run.patchRun = (options) => {
    sanitizeRunTree(run, integration);
    return patchRun({ excludeInputs: false, ...options });
  };

  const end = run.end.bind(run);
  run.end = (outputs, error, endTime, metadata) => {
    const status = error != null ? "error" : endTime != null ? "completed" : statusOfRun(run);
    const safeMetadata = metadataForMode(metadata, integration, "metadata", status) ?? { status };
    return end(mutedContent("assistant"), undefined, endTime, safeMetadata);
  };

  const toJSON = run.toJSON.bind(run);
  run.toJSON = () => {
    sanitizeRunTree(run, integration);
    return toJSON();
  };

  return run;
}

function preserveFullModePatchInputs(run: RunTree): RunTree {
  const createChild = run.createChild.bind(run);
  run.createChild = (config) => preserveFullModePatchInputs(createChild(config));
  const patchRun = run.patchRun.bind(run);
  run.patchRun = (options) => patchRun({ excludeInputs: false, ...options });
  return run;
}

export function createCodingAgentRunTree(
  config: RunTreeConfig,
  integration: CodingAgentIntegration,
  mode: CodingAgentMetadataMode = "full",
  privacyContext?: CodingAgentPrivacyContext,
): RunTree {
  const run = new RunTree(
    mode === "metadata" ? configForMetadataMode(config, integration, privacyContext) : config,
  );
  return mode === "metadata" ? protectRunTree(run, integration) : preserveFullModePatchInputs(run);
}

export function survivingCodingAgentPatchFields(
  projectedRun: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.filter((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(projectedRun, field);
    return (
      descriptor?.enumerable === true && "value" in descriptor && descriptor.value !== undefined
    );
  });
}
