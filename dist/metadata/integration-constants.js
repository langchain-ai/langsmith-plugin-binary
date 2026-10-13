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
export const CODING_AGENT_CODEX_ONLY_INTEGRATIONS = ["openai-codex"];
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
};
export const CODING_AGENT_RUNTIME_NAMES = {
    "claude-code": "claude-code",
    "openai-codex": "openai-codex",
    "deepagents-code": "deepagents-code",
    "cursor": "cursor",
    "pi": "pi",
};
//# sourceMappingURL=integration-constants.js.map