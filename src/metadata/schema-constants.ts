import type { CodingAgentMetadataFieldOptions, CodingAgentRunType } from "./models.js";
import { CODING_AGENT_CORE_INTEGRATIONS } from "./integration-constants.js";

export const CODING_AGENT_SCHEMA_VERSION = "coding-agent-v1";

export const CODING_AGENT_PURPOSE = "coding";

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
  chain: ["root", "subagent", "interrupted"],
} as const satisfies Record<string, readonly CodingAgentRunType[]>;

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
