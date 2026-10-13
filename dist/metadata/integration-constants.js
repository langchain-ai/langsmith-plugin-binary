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
//# sourceMappingURL=integration-constants.js.map