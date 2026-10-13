export declare const CODING_AGENT_SCHEMA_INTEGRATIONS: readonly ["claude-code", "openai-codex", "deepagents-code", "cursor", "pi"];
export declare const CODING_AGENT_SUPPORTED_INTEGRATIONS: readonly ["claude-code", "cursor", "openai-codex"];
export declare const CODING_AGENT_CODEX_ONLY_INTEGRATIONS: readonly ["openai-codex"];
export declare const CODING_AGENT_INTEGRATION_POLICIES: {
    readonly "claude-code": {
        readonly fullModePrecedence: "custom-wins";
        readonly metadataModeUsesDirectMetadata: true;
        readonly metadataModePreservesToolName: false;
        readonly legacyAliases: true;
    };
    readonly cursor: {
        readonly fullModePrecedence: "custom-wins";
        readonly metadataModeUsesDirectMetadata: true;
        readonly metadataModePreservesToolName: true;
        readonly legacyAliases: false;
    };
    readonly "openai-codex": {
        readonly fullModePrecedence: "structural-wins";
        readonly metadataModeUsesDirectMetadata: false;
        readonly metadataModePreservesToolName: false;
        readonly legacyAliases: false;
    };
};
export declare const CODING_AGENT_RUNTIME_NAMES: {
    readonly "claude-code": "claude-code";
    readonly "openai-codex": "openai-codex";
    readonly "deepagents-code": "deepagents-code";
    readonly cursor: "cursor";
    readonly pi: "pi";
};
//# sourceMappingURL=integration-constants.d.ts.map