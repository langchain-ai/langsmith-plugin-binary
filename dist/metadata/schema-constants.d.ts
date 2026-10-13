export declare const CODING_AGENT_SCHEMA_VERSION = "coding-agent-v1";
export declare const CODING_AGENT_PURPOSE = "coding";
export declare const CODING_AGENT_RUN_TYPES: readonly ["root", "llm", "tool", "subagent", "interrupted"];
export declare const CODING_AGENT_RUN_SCOPES: {
    readonly all: readonly ["root", "llm", "tool", "subagent", "interrupted"];
    readonly rootInterrupted: readonly ["root", "interrupted"];
    readonly subagent: readonly ["subagent"];
    readonly tool: readonly ["tool"];
    readonly llmTool: readonly ["llm", "tool"];
    readonly chain: readonly ["root", "subagent", "interrupted"];
};
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
//# sourceMappingURL=schema-constants.d.ts.map