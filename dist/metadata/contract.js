import { ATTRIBUTION_IDENTIFIER_KEY, CODING_AGENT_ALWAYS_FIELD_OPTIONS, CODING_AGENT_AGENT_TYPES, CODING_AGENT_CODEX_INTEGRATION, CODING_AGENT_CORE_INTEGRATIONS, CODING_AGENT_FIELD_DEFAULTS, CODING_AGENT_INTEGRATION_POLICIES, CODING_AGENT_PROVIDER_FIELD_DEFAULTS, CODING_AGENT_ENVIRONMENT_METADATA_ENDPOINT_SUBSTRINGS, CODING_AGENT_ENVIRONMENT_METADATA_EXCLUDED, CODING_AGENT_ENVIRONMENT_METADATA_PREFIXES, CODING_AGENT_ENVIRONMENT_METADATA_SENSITIVE_SUBSTRINGS, CODING_AGENT_PURPOSE, CODING_AGENT_RUNTIME_NAMES, CODING_AGENT_RELEASE_ENVIRONMENT_VARIABLES, CODING_AGENT_REVISION_ID_KEY, CODING_AGENT_REVISION_ID_VARIABLE, CODING_AGENT_RUN_SCOPES, CODING_AGENT_RUNTIME_LIBRARY, CODING_AGENT_RUNTIME_SDK, CODING_AGENT_SCHEMA_INTEGRATIONS, CODING_AGENT_SCHEMA_VERSION, CODING_AGENT_STRUCTURAL_FIELD_DEFAULTS, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS, GIT_METADATA_KEYS, LEGACY_GIT_METADATA_KEYS, } from "./constants.js";
function field(key, options = {}) {
    return { key, ...CODING_AGENT_FIELD_DEFAULTS, ...options };
}
const structural = (key, options = {}) => field(key, { ...CODING_AGENT_STRUCTURAL_FIELD_DEFAULTS, ...options });
const provider = (key, options = {}) => field(key, { ...CODING_AGENT_PROVIDER_FIELD_DEFAULTS, ...options });
export const CODING_AGENT_V1_CONTRACT = {
    schemaVersion: CODING_AGENT_SCHEMA_VERSION,
    integrations: CODING_AGENT_SCHEMA_INTEGRATIONS,
    runtimeNames: CODING_AGENT_RUNTIME_NAMES,
    keys: [
        structural("ls_agent_purpose", {
            ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
            allowedValues: [CODING_AGENT_PURPOSE],
        }),
        structural("ls_integration", {
            ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
            allowedValues: CODING_AGENT_SCHEMA_INTEGRATIONS,
        }),
        structural("ls_agent_runtime", {
            ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
            allowedValues: Object.values(CODING_AGENT_RUNTIME_NAMES),
        }),
        structural("thread_id", CODING_AGENT_ALWAYS_FIELD_OPTIONS),
        structural("ls_trace_schema_version", {
            ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
            allowedValues: [CODING_AGENT_SCHEMA_VERSION],
        }),
        structural("ls_agent_type", {
            ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
            allowedValues: CODING_AGENT_AGENT_TYPES,
        }),
        structural("ls_integration_version", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        structural("ls_agent_runtime_version", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        structural("turn_id", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        structural("turn_number", { ...CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS, type: "integer" }),
        field(GIT_METADATA_KEYS.repositoryUrl, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field(GIT_METADATA_KEYS.provider, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field(GIT_METADATA_KEYS.repository, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field(GIT_METADATA_KEYS.branch, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field(GIT_METADATA_KEYS.commit, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field(LEGACY_GIT_METADATA_KEYS.repositoryUrl, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field(LEGACY_GIT_METADATA_KEYS.provider, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field(LEGACY_GIT_METADATA_KEYS.repository, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field(LEGACY_GIT_METADATA_KEYS.branch, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field(LEGACY_GIT_METADATA_KEYS.commit, CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field("cwd", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
        field("ls_skill_name", {
            appliesTo: CODING_AGENT_RUN_SCOPES.tool,
            metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
        }),
        field(ATTRIBUTION_IDENTIFIER_KEY),
        field("user_id"),
        field("local_username"),
        field("user_email"),
        field("sandbox_type"),
        field("approval_policy", { appliesTo: CODING_AGENT_RUN_SCOPES.rootInterrupted }),
        field("ls_subagent_id", {
            appliesTo: CODING_AGENT_RUN_SCOPES.subagent,
            metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
        }),
        field("ls_subagent_type", {
            appliesTo: CODING_AGENT_RUN_SCOPES.subagent,
            metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
        }),
        field("ls_tool_name", {
            appliesTo: CODING_AGENT_RUN_SCOPES.tool,
            metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
        }),
        provider("ls_provider", {
            appliesTo: CODING_AGENT_RUN_SCOPES.llmTool,
            metadataModeIntegrations: CODING_AGENT_CODEX_INTEGRATION,
        }),
        provider("ls_model_type", {
            appliesTo: CODING_AGENT_RUN_SCOPES.llmTool,
            metadataModeIntegrations: CODING_AGENT_CODEX_INTEGRATION,
            providerIntegrations: CODING_AGENT_CODEX_INTEGRATION,
        }),
        provider("ls_message_format", {
            metadataModeIntegrations: CODING_AGENT_CODEX_INTEGRATION,
            providerIntegrations: CODING_AGENT_CODEX_INTEGRATION,
        }),
        provider("codex_cli_version", {
            metadataModeIntegrations: CODING_AGENT_CODEX_INTEGRATION,
            providerIntegrations: CODING_AGENT_CODEX_INTEGRATION,
        }),
        provider("ls_raw_aggregated_usage", {
            appliesTo: CODING_AGENT_RUN_SCOPES.chain,
            type: "object",
            metadataModeIntegrations: CODING_AGENT_CODEX_INTEGRATION,
            providerIntegrations: CODING_AGENT_CODEX_INTEGRATION,
        }),
        provider("ls_invocation_params", {
            appliesTo: CODING_AGENT_RUN_SCOPES.llmTool,
            type: "object",
        }),
        field("usage_metadata", {
            type: "object",
            metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
            metadataSource: "explicit",
        }),
        field("ls_model_name", {
            metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
            metadataSource: "explicit",
        }),
    ],
    runtime: {
        library: CODING_AGENT_RUNTIME_LIBRARY,
        sdk: CODING_AGENT_RUNTIME_SDK,
        releaseEnvironmentVariables: CODING_AGENT_RELEASE_ENVIRONMENT_VARIABLES,
        environmentMetadata: {
            prefixes: CODING_AGENT_ENVIRONMENT_METADATA_PREFIXES,
            excluded: CODING_AGENT_ENVIRONMENT_METADATA_EXCLUDED,
            sensitiveSubstrings: CODING_AGENT_ENVIRONMENT_METADATA_SENSITIVE_SUBSTRINGS,
            endpointSubstrings: CODING_AGENT_ENVIRONMENT_METADATA_ENDPOINT_SUBSTRINGS,
            revisionId: {
                variable: CODING_AGENT_REVISION_ID_VARIABLE,
                key: CODING_AGENT_REVISION_ID_KEY,
            },
        },
    },
    integrationPolicies: CODING_AGENT_INTEGRATION_POLICIES,
};
//# sourceMappingURL=contract.js.map