import type { GIT_METADATA_KEYS, REPOSITORY_METADATA_KEYS } from "./constants.js";
export type CodingAgentIntegration = "claude-code" | "cursor" | "openai-codex";
export type CodingAgentSchemaIntegration = CodingAgentIntegration | "deepagents-code" | "pi";
export type CodingAgentAgentType = "root" | "subagent" | "middleware" | "compaction";
export type CodingAgentRunType = "root" | "llm" | "tool" | "subagent" | "interrupted";
export type CodingAgentMetadataMode = "full" | "metadata";
export interface CodingAgentIntegrationPolicy {
    fullModePrecedence: "custom-wins" | "structural-wins";
    metadataModeUsesDirectMetadata: boolean;
    metadataModePreservesToolName: boolean;
    legacyAliases: boolean;
}
export interface CodingAgentMetadataField {
    key: string;
    appliesTo: readonly CodingAgentRunType[];
    type: "string" | "integer" | "object";
    allowedValues: readonly unknown[] | null;
    requirement: "always" | "where_known" | "contextual";
    requiredWhereKnown: boolean;
    metadataModeIntegrations: readonly CodingAgentSchemaIntegration[];
    metadataSource?: "structural" | "explicit" | "provider";
    providerIntegrations?: readonly CodingAgentIntegration[];
}
export type CodingAgentMetadataFieldOptions = Partial<Omit<CodingAgentMetadataField, "key">>;
interface CodingAgentRevisionIdContract {
    variable: string;
    key: string;
}
export interface CodingAgentEnvironmentMetadataContract {
    prefixes: readonly string[];
    excluded: readonly string[];
    sensitiveSubstrings: readonly string[];
    endpointSubstrings: readonly string[];
    revisionId: CodingAgentRevisionIdContract;
}
interface CodingAgentRuntimeContract {
    library: string;
    sdk: string;
    releaseEnvironmentVariables: readonly string[];
    environmentMetadata: CodingAgentEnvironmentMetadataContract;
}
export interface CodingAgentRuntimeOptions {
    env: Readonly<Record<string, string | undefined>>;
    runtime: string;
    sdkVersion: string;
}
export interface CodingAgentRuntimeMetadata {
    runtime: Record<string, string>;
    metadata: Record<string, string>;
}
export interface CodingAgentV1Contract {
    schemaVersion: string;
    integrations: readonly CodingAgentSchemaIntegration[];
    runtimeNames: Readonly<Record<CodingAgentSchemaIntegration, string>>;
    keys: readonly CodingAgentMetadataField[];
    runtime: CodingAgentRuntimeContract;
    integrationPolicies: Readonly<Record<CodingAgentIntegration, CodingAgentIntegrationPolicy>>;
}
interface ProviderMetadata {
    ls_provider?: string | undefined;
    ls_model_type?: string | undefined;
    ls_message_format?: string | undefined;
    codex_cli_version?: string | undefined;
    ls_raw_aggregated_usage?: Record<string, unknown> | undefined;
    ls_invocation_params?: Record<string, unknown> | undefined;
}
export type CodingAgentMetadataWithTrustedProjection = Record<string, unknown> & {
    [key: symbol]: Record<string, unknown> | undefined;
};
export interface CodingAgentMetadataOptions {
    integration: CodingAgentIntegration;
    integrationVersion?: string | undefined;
    runtimeVersion?: string | undefined;
    threadId: string;
    turnId?: string | undefined;
    turnNumber?: number | undefined;
    agentType: CodingAgentAgentType;
    runType: CodingAgentRunType;
    approvalPolicy?: string | undefined;
    subagentId?: string | undefined;
    subagentType?: string | undefined;
    clearSubagent?: boolean | undefined;
    toolName?: string | undefined;
    runName?: string | undefined;
    skillName?: string | undefined;
    modelName?: string | undefined;
    usageMetadata?: Record<string, unknown> | undefined;
    providerMetadata?: ProviderMetadata | Record<string, unknown> | undefined;
    runSpecific?: Record<string, unknown> | undefined;
    base?: Record<string, unknown> | undefined;
}
export type CodingAgentMetadataProvenanceResult = {
    status: "ready";
    value: CodingAgentMetadataOptions;
} | {
    status: "deferred";
};
export interface MetadataValidationIssue {
    key: string;
    reason: "missing" | "type" | "value" | "scope" | "integration";
}
export type GitMetadataRole = keyof typeof GIT_METADATA_KEYS;
export type RepositoryAttribution = Partial<Record<(typeof REPOSITORY_METADATA_KEYS)[number], string>>;
export {};
//# sourceMappingURL=models.d.ts.map