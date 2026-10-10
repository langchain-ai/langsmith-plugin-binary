export declare const CODING_AGENT_SCHEMA_VERSION = "coding-agent-v1";
export declare const CODING_AGENT_RUN_TYPES: readonly ["root", "llm", "tool", "subagent", "interrupted"];
export declare const CODING_AGENT_RUN_SCOPES: {
    readonly all: readonly ["root", "llm", "tool", "subagent", "interrupted"];
    readonly rootInterrupted: readonly ["root", "interrupted"];
    readonly subagent: readonly ["subagent"];
    readonly tool: readonly ["tool"];
    readonly llmTool: readonly ["llm", "tool"];
    readonly root: readonly ["root"];
};
export declare const CODING_AGENT_SCHEMA_INTEGRATIONS: readonly ["claude-code", "openai-codex", "deepagents-code", "cursor", "pi"];
export declare const CODING_AGENT_SUPPORTED_INTEGRATIONS: readonly ["claude-code", "cursor", "openai-codex"];
export declare const CODING_AGENT_CORE_INTEGRATIONS: readonly ["claude-code", "cursor", "openai-codex"];
export declare const CODING_AGENT_CODEX_INTEGRATION: readonly ["openai-codex"];
export declare const CODING_AGENT_AGENT_TYPES: readonly ["root", "subagent", "middleware", "compaction"];
export declare const CODING_AGENT_ALWAYS_FIELD_OPTIONS: {
    readonly requirement: "always";
};
export declare const CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS: {
    readonly requirement: "where_known";
    readonly requiredWhereKnown: true;
};
export declare const CODING_AGENT_FIELD_DEFAULTS: {
    readonly appliesTo: readonly ["root", "llm", "tool", "subagent", "interrupted"];
    readonly type: "string";
    readonly allowedValues: null;
    readonly requirement: "contextual";
    readonly requiredWhereKnown: false;
    readonly metadataModeIntegrations: readonly [];
};
export declare const CODING_AGENT_STRUCTURAL_FIELD_DEFAULTS: {
    readonly metadataModeIntegrations: readonly ["claude-code", "cursor", "openai-codex"];
    readonly metadataSource: "structural";
};
export declare const CODING_AGENT_PROVIDER_FIELD_DEFAULTS: {
    readonly metadataSource: "provider";
    readonly providerIntegrations: readonly ["claude-code", "cursor", "openai-codex"];
};
export declare const CODING_AGENT_INTEGRATION_POLICIES: {
    readonly "claude-code": {
        readonly fullModePrecedence: "custom-wins";
        readonly metadataModeUsesDirectMetadata: true;
        readonly legacyAliases: true;
    };
    readonly cursor: {
        readonly fullModePrecedence: "custom-wins";
        readonly metadataModeUsesDirectMetadata: true;
        readonly legacyAliases: false;
    };
    readonly "openai-codex": {
        readonly fullModePrecedence: "structural-wins";
        readonly metadataModeUsesDirectMetadata: false;
        readonly legacyAliases: false;
    };
};
export declare const TRUSTED_METADATA: unique symbol;
export declare const METADATA_MODE_STATUS_VALUES: readonly ["running", "completed", "error"];
export declare const METADATA_MODE_NAME = "metadata";
//# sourceMappingURL=constants.d.ts.map