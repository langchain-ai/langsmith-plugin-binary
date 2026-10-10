export const CODING_AGENT_SCHEMA_VERSION = "coding-agent-v1";
export const CODING_AGENT_RUN_TYPES = [
    "root",
    "llm",
    "tool",
    "subagent",
    "interrupted",
];
export const CODING_AGENT_RUN_SCOPES = {
    all: CODING_AGENT_RUN_TYPES,
    rootInterrupted: ["root", "interrupted"],
    subagent: ["subagent"],
    tool: ["tool"],
    llmTool: ["llm", "tool"],
    root: ["root"],
};
export const CODING_AGENT_SCHEMA_INTEGRATIONS = [
    "claude-code",
    "openai-codex",
    "deepagents-code",
    "cursor",
    "pi",
];
export const CODING_AGENT_SUPPORTED_INTEGRATIONS = [
    "claude-code",
    "cursor",
    "openai-codex",
];
export const CODING_AGENT_CORE_INTEGRATIONS = CODING_AGENT_SUPPORTED_INTEGRATIONS;
export const CODING_AGENT_CODEX_INTEGRATION = ["openai-codex"];
export const CODING_AGENT_AGENT_TYPES = ["root", "subagent", "middleware", "compaction"];
export const CODING_AGENT_ALWAYS_FIELD_OPTIONS = {
    requirement: "always",
};
export const CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS = {
    requirement: "where_known",
    requiredWhereKnown: true,
};
export const CODING_AGENT_FIELD_DEFAULTS = {
    appliesTo: CODING_AGENT_RUN_TYPES,
    type: "string",
    allowedValues: null,
    requirement: "contextual",
    requiredWhereKnown: false,
    metadataModeIntegrations: [],
};
export const CODING_AGENT_STRUCTURAL_FIELD_DEFAULTS = {
    metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
    metadataSource: "structural",
};
export const CODING_AGENT_PROVIDER_FIELD_DEFAULTS = {
    metadataSource: "provider",
    providerIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
};
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
};
export const TRUSTED_METADATA = Symbol("coding-agent trusted metadata");
export const METADATA_MODE_STATUS_VALUES = ["running", "completed", "error"];
export const METADATA_MODE_NAME = "metadata";
//# sourceMappingURL=constants.js.map