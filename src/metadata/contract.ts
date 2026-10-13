import {
  CODING_AGENT_ALWAYS_FIELD_OPTIONS,
  CODING_AGENT_AGENT_TYPES,
  CODING_AGENT_FIELD_DEFAULTS,
  CODING_AGENT_PROVIDER_FIELD_DEFAULTS,
  CODING_AGENT_PURPOSE,
  CODING_AGENT_RUN_SCOPES,
  CODING_AGENT_SCHEMA_VERSION,
  CODING_AGENT_STRUCTURAL_FIELD_DEFAULTS,
  CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS,
} from "./schema-constants.js";
import {
  CODING_AGENT_CODEX_ONLY_INTEGRATIONS,
  CODING_AGENT_SUPPORTED_INTEGRATIONS,
  CODING_AGENT_INTEGRATION_POLICIES,
  CODING_AGENT_RUNTIME_NAMES,
  CODING_AGENT_SCHEMA_INTEGRATIONS,
} from "./integration-constants.js";
import type {
  CodingAgentMetadataField,
  CodingAgentMetadataFieldOptions,
  CodingAgentV1Contract,
} from "./models.js";

function field(
  key: string,
  options: CodingAgentMetadataFieldOptions = {},
): CodingAgentMetadataField {
  return { key, ...CODING_AGENT_FIELD_DEFAULTS, ...options };
}

const structural = (key: string, options: CodingAgentMetadataFieldOptions = {}) =>
  field(key, { ...CODING_AGENT_STRUCTURAL_FIELD_DEFAULTS, ...options });
const provider = (key: string, options: CodingAgentMetadataFieldOptions = {}) =>
  field(key, { ...CODING_AGENT_PROVIDER_FIELD_DEFAULTS, ...options });

export const CODING_AGENT_V1_CONTRACT: CodingAgentV1Contract = {
  schemaVersion: CODING_AGENT_SCHEMA_VERSION,
  integrations: CODING_AGENT_SCHEMA_INTEGRATIONS,
  runtimeNames: CODING_AGENT_RUNTIME_NAMES,
  keys: [
    structural("ls_agent_purpose", {
      ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
      allowedValues: [CODING_AGENT_PURPOSE],
    }),
    structural("ls_integration", {
      ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
      allowedValues: CODING_AGENT_SCHEMA_INTEGRATIONS,
    }),
    structural("ls_agent_runtime", {
      ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
      allowedValues: Object.values(CODING_AGENT_RUNTIME_NAMES),
    }),
    structural("thread_id", CODING_AGENT_ALWAYS_FIELD_OPTIONS),
    structural("ls_trace_schema_version", {
      ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
      allowedValues: [CODING_AGENT_SCHEMA_VERSION],
    }),
    structural("ls_agent_type", {
      ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
      allowedValues: CODING_AGENT_AGENT_TYPES,
    }),
    structural("ls_integration_version", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    structural("ls_agent_runtime_version", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    structural("turn_id", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    structural("turn_number", { ...CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS, type: "integer" }),
    field("repository_url", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("repository_provider", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("repository_name", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("git_branch", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("git_commit_sha", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("cwd", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("ls_skill_name", {
      appliesTo: CODING_AGENT_RUN_SCOPES.tool,
      metadataModeIntegrations: CODING_AGENT_SUPPORTED_INTEGRATIONS,
    }),
    field("ls_attribution_identifier"),
    field("user_id"),
    field("local_username"),
    field("user_email"),
    field("sandbox_type"),
    field("approval_policy", { appliesTo: CODING_AGENT_RUN_SCOPES.rootInterrupted }),
    field("ls_subagent_id", {
      appliesTo: CODING_AGENT_RUN_SCOPES.subagent,
      metadataModeIntegrations: CODING_AGENT_SUPPORTED_INTEGRATIONS,
    }),
    field("ls_subagent_type", {
      appliesTo: CODING_AGENT_RUN_SCOPES.subagent,
      metadataModeIntegrations: CODING_AGENT_SUPPORTED_INTEGRATIONS,
    }),
    field("ls_tool_name", {
      appliesTo: CODING_AGENT_RUN_SCOPES.tool,
      metadataModeIntegrations: CODING_AGENT_SUPPORTED_INTEGRATIONS,
    }),
    provider("ls_provider", {
      appliesTo: CODING_AGENT_RUN_SCOPES.llmTool,
      metadataModeIntegrations: CODING_AGENT_CODEX_ONLY_INTEGRATIONS,
    }),
    provider("ls_model_type", {
      appliesTo: CODING_AGENT_RUN_SCOPES.llmTool,
      metadataModeIntegrations: CODING_AGENT_CODEX_ONLY_INTEGRATIONS,
      providerIntegrations: CODING_AGENT_CODEX_ONLY_INTEGRATIONS,
    }),
    provider("ls_message_format", {
      metadataModeIntegrations: CODING_AGENT_CODEX_ONLY_INTEGRATIONS,
      providerIntegrations: CODING_AGENT_CODEX_ONLY_INTEGRATIONS,
    }),
    provider("codex_cli_version", {
      metadataModeIntegrations: CODING_AGENT_CODEX_ONLY_INTEGRATIONS,
      providerIntegrations: CODING_AGENT_CODEX_ONLY_INTEGRATIONS,
    }),
    provider("ls_raw_aggregated_usage", {
      appliesTo: CODING_AGENT_RUN_SCOPES.chain,
      type: "object",
      metadataModeIntegrations: CODING_AGENT_CODEX_ONLY_INTEGRATIONS,
      providerIntegrations: CODING_AGENT_CODEX_ONLY_INTEGRATIONS,
    }),
    provider("ls_invocation_params", {
      appliesTo: CODING_AGENT_RUN_SCOPES.llmTool,
      type: "object",
    }),
    field("usage_metadata", {
      type: "object",
      metadataModeIntegrations: CODING_AGENT_SUPPORTED_INTEGRATIONS,
      metadataSource: "explicit",
    }),
    field("ls_model_name", {
      metadataModeIntegrations: CODING_AGENT_SUPPORTED_INTEGRATIONS,
      metadataSource: "explicit",
    }),
  ],
  integrationPolicies: CODING_AGENT_INTEGRATION_POLICIES,
};
