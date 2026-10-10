export const CODING_AGENT_SCHEMA_VERSION = "coding-agent-v1";
export const CODING_AGENT_PURPOSE = "coding";
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
    chain: ["root", "subagent", "interrupted"],
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
        metadataModePreservesToolName: false,
        legacyAliases: true,
    },
    cursor: {
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
};
export const TRUSTED_METADATA = Symbol("coding-agent trusted metadata");
export const METADATA_MODE_STATUS_VALUES = ["running", "completed", "error"];
export const METADATA_MODE_NAME = "metadata";
export const CODING_AGENT_METADATA_PROVENANCE_FIELDS = [
    "integration",
    "integrationVersion",
    "runtimeVersion",
    "threadId",
    "turnId",
    "turnNumber",
    "agentType",
    "runType",
    "approvalPolicy",
    "subagentId",
    "subagentType",
    "clearSubagent",
    "toolName",
    "runName",
    "skillName",
    "modelName",
    "usageMetadata",
    "providerMetadata",
    "runSpecific",
    "base",
];
export const CODING_AGENT_METADATA_PROJECTION_FIELDS = [
    ["integrationVersion", "ls_integration_version"],
    ["runtimeVersion", "ls_agent_runtime_version"],
    ["turnId", "turn_id"],
    ["turnNumber", "turn_number"],
    ["approvalPolicy", "approval_policy"],
    ["subagentId", "ls_subagent_id"],
    ["subagentType", "ls_subagent_type"],
    ["skillName", "ls_skill_name"],
    ["modelName", "ls_model_name"],
];
//# sourceMappingURL=constants.js.map