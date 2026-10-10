import {
  CODING_AGENT_INTEGRATION_POLICIES,
  CODING_AGENT_SCHEMA_VERSION,
  TRUSTED_METADATA,
} from "./constants.js";
import { CODING_AGENT_V1_CONTRACT } from "./contract.js";
import type {
  CodingAgentMetadataOptions,
  CodingAgentMetadataWithTrustedProjection,
} from "./models.js";
import { normalizeProviderMetadata } from "./validation.js";

export function buildCodingAgentMetadata(
  options: CodingAgentMetadataOptions,
): Record<string, unknown> {
  const policy = CODING_AGENT_INTEGRATION_POLICIES[options.integration];
  const identity: Record<string, unknown> = {
    ls_agent_purpose: "coding",
    ls_integration: options.integration,
    ls_agent_runtime: CODING_AGENT_V1_CONTRACT.runtimeNames[options.integration],
    ls_trace_schema_version: CODING_AGENT_SCHEMA_VERSION,
    ls_agent_type: options.agentType,
    thread_id: options.threadId,
  };
  if (options.integrationVersion) identity.ls_integration_version = options.integrationVersion;
  if (options.runtimeVersion) identity.ls_agent_runtime_version = options.runtimeVersion;
  if (options.turnId) identity.turn_id = options.turnId;
  if (typeof options.turnNumber === "number") identity.turn_number = options.turnNumber;
  if (options.approvalPolicy) identity.approval_policy = options.approvalPolicy;
  if (options.clearSubagent) {
    identity.ls_subagent_id = undefined;
    identity.ls_subagent_type = undefined;
  } else {
    if (options.subagentId) identity.ls_subagent_id = options.subagentId;
    if (options.subagentType) identity.ls_subagent_type = options.subagentType;
  }
  if (options.toolName) {
    if (policy.legacyAliases) identity.tool_name = options.toolName;
    if (options.runName && options.toolName !== options.runName) {
      identity.ls_tool_name = options.toolName;
    }
  }
  if (options.skillName) identity.ls_skill_name = options.skillName;
  if (policy.legacyAliases && options.subagentId) identity.agent_id = options.subagentId;
  if (policy.legacyAliases && options.subagentType) identity.agent_type = options.subagentType;

  const explicit: Record<string, unknown> = {};
  if (options.modelName !== undefined) explicit.ls_model_name = options.modelName;
  if (options.usageMetadata !== undefined) explicit.usage_metadata = options.usageMetadata;
  const provider = normalizeProviderMetadata(
    options.providerMetadata,
    options.integration,
    options.runType,
  );
  const trusted = { ...identity, ...explicit, ...provider };
  if (policy.metadataModePreservesToolName && options.toolName) {
    trusted.ls_tool_name = options.toolName;
  }
  const pieces = [identity, explicit, provider, options.runSpecific, options.base];
  const full = policy.fullModePrecedence === "custom-wins" ? pieces : pieces.toReversed();
  const result: Record<string, unknown> = {};
  for (const piece of full) {
    if (piece) Object.assign(result, piece);
  }
  Object.defineProperty(result, TRUSTED_METADATA, { value: trusted });
  return result;
}

export function trustedCodingAgentMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return (metadata as CodingAgentMetadataWithTrustedProjection | undefined)?.[TRUSTED_METADATA];
}
