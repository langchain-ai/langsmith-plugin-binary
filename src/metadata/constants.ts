import type {
  CodingAgentIntegration,
  CodingAgentIntegrationPolicy,
  CodingAgentMetadataFieldOptions,
  CodingAgentRunType,
  CodingAgentSchemaIntegration,
} from "./models.js";

export const CODING_AGENT_SCHEMA_VERSION = "coding-agent-v1";
export const CODING_AGENT_RUN_TYPES = [
  "root",
  "llm",
  "tool",
  "subagent",
  "interrupted",
] as const satisfies readonly CodingAgentRunType[];
export const CODING_AGENT_RUN_SCOPES = {
  all: CODING_AGENT_RUN_TYPES,
  rootInterrupted: ["root", "interrupted"],
  subagent: ["subagent"],
  tool: ["tool"],
  llmTool: ["llm", "tool"],
  root: ["root"],
} as const satisfies Record<string, readonly CodingAgentRunType[]>;
export const CODING_AGENT_SCHEMA_INTEGRATIONS = [
  "claude-code",
  "openai-codex",
  "deepagents-code",
  "cursor",
  "pi",
] as const satisfies readonly CodingAgentSchemaIntegration[];
export const CODING_AGENT_SUPPORTED_INTEGRATIONS = [
  "claude-code",
  "cursor",
  "openai-codex",
] as const satisfies readonly CodingAgentIntegration[];
export const CODING_AGENT_CORE_INTEGRATIONS = CODING_AGENT_SUPPORTED_INTEGRATIONS;
export const CODING_AGENT_CODEX_INTEGRATION = ["openai-codex"] as const;
export const CODING_AGENT_AGENT_TYPES = ["root", "subagent", "middleware", "compaction"] as const;
export const CODING_AGENT_ALWAYS_FIELD_OPTIONS = {
  requirement: "always",
} as const satisfies CodingAgentMetadataFieldOptions;
export const CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS = {
  requirement: "where_known",
  requiredWhereKnown: true,
} as const satisfies CodingAgentMetadataFieldOptions;
export const CODING_AGENT_FIELD_DEFAULTS = {
  appliesTo: CODING_AGENT_RUN_TYPES,
  type: "string",
  allowedValues: null,
  requirement: "contextual",
  requiredWhereKnown: false,
  metadataModeIntegrations: [],
} as const satisfies CodingAgentMetadataFieldOptions;
export const CODING_AGENT_STRUCTURAL_FIELD_DEFAULTS = {
  metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
  metadataSource: "structural",
} as const satisfies CodingAgentMetadataFieldOptions;
export const CODING_AGENT_PROVIDER_FIELD_DEFAULTS = {
  metadataSource: "provider",
  providerIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
} as const satisfies CodingAgentMetadataFieldOptions;
export const CODING_AGENT_INTEGRATION_POLICIES = {
  "claude-code": {
    fullModePrecedence: "custom-wins",
    metadataModeUsesDirectMetadata: true,
    legacyAliases: true,
  },
  cursor: {
    fullModePrecedence: "custom-wins",
    metadataModeUsesDirectMetadata: true,
    legacyAliases: false,
  },
  "openai-codex": {
    fullModePrecedence: "structural-wins",
    metadataModeUsesDirectMetadata: false,
    legacyAliases: false,
  },
} as const satisfies Readonly<Record<CodingAgentIntegration, CodingAgentIntegrationPolicy>>;
export const TRUSTED_METADATA = Symbol("coding-agent trusted metadata");
export const METADATA_MODE_STATUS_VALUES = ["running", "completed", "error"] as const;
export const METADATA_MODE_NAME = "metadata";
