import type {
  CodingAgentIntegration,
  CodingAgentIntegrationPolicy,
  CodingAgentSchemaIntegration,
} from "./models.js";

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

export const CODING_AGENT_CODEX_ONLY_INTEGRATIONS = ["openai-codex"] as const;

export const CODING_AGENT_INTEGRATION_POLICIES = {
  "claude-code": {
    fullModePrecedence: "custom-wins",
    metadataModeUsesDirectMetadata: true,
    metadataModePreservesToolName: false,
    legacyAliases: true,
  },
  "cursor": {
    fullModePrecedence: "custom-wins",
    metadataModeUsesDirectMetadata: true,
    metadataModePreservesToolName: true,
    legacyAliases: false,
  },
  "openai-codex": {
    fullModePrecedence: "structural-wins",
    metadataModeUsesDirectMetadata: false,
    metadataModePreservesToolName: false,
    legacyAliases: false,
  },
} as const satisfies Readonly<Record<CodingAgentIntegration, CodingAgentIntegrationPolicy>>;

export const CODING_AGENT_RUNTIME_NAMES = {
  "claude-code": "claude-code",
  "openai-codex": "openai-codex",
  "deepagents-code": "deepagents-code",
  "cursor": "cursor",
  "pi": "pi",
} as const satisfies Readonly<Record<CodingAgentSchemaIntegration, string>>;
