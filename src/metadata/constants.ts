import type {
  CodingAgentMetadataOptions,
  CodingAgentIntegration,
  CodingAgentIntegrationPolicy,
  CodingAgentMetadataFieldOptions,
  CodingAgentRunType,
  CodingAgentSchemaIntegration,
} from "./models.js";

// Schema version and purpose
export const CODING_AGENT_SCHEMA_VERSION = "coding-agent-v1";
export const CODING_AGENT_PURPOSE = "coding";

// Repository and author keys attached to runs
export const GIT_METADATA_KEYS = {
  repository: "ls_git_repo",
  repositoryUrl: "ls_git_repo_url",
  provider: "ls_repo_provider",
  branch: "ls_git_branch",
  commit: "ls_git_commit_hash",
} as const;
export const LEGACY_GIT_METADATA_KEYS = {
  repository: "repository_name",
  repositoryUrl: "repository_url",
  provider: "repository_provider",
  branch: "git_branch",
  commit: "git_commit_sha",
} as const satisfies Record<keyof typeof GIT_METADATA_KEYS, string>;
export const ATTRIBUTION_IDENTIFIER_KEY = "ls_attribution_identifier";
export const HOOK_METADATA_KEY = "ls_hooks";
export const REPOSITORY_METADATA_KEYS = [
  GIT_METADATA_KEYS.repository,
  GIT_METADATA_KEYS.provider,
  GIT_METADATA_KEYS.repositoryUrl,
  GIT_METADATA_KEYS.branch,
  GIT_METADATA_KEYS.commit,
  LEGACY_GIT_METADATA_KEYS.repository,
  LEGACY_GIT_METADATA_KEYS.provider,
  LEGACY_GIT_METADATA_KEYS.repositoryUrl,
  LEGACY_GIT_METADATA_KEYS.branch,
  LEGACY_GIT_METADATA_KEYS.commit,
  ATTRIBUTION_IDENTIFIER_KEY,
] as const;

// Run and agent types
export const CODING_AGENT_RUN_TYPES = [
  "root",
  "llm",
  "tool",
  "subagent",
  "interrupted",
] as const satisfies readonly CodingAgentRunType[];
export const CODING_AGENT_RUN_SCOPES = {
  all: CODING_AGENT_RUN_TYPES,
  rootInterrupted: ["root", "interrupted"],
  subagent: ["subagent"],
  tool: ["tool"],
  llmTool: ["llm", "tool"],
  chain: ["root", "subagent", "interrupted"],
} as const satisfies Record<string, readonly CodingAgentRunType[]>;
export const CODING_AGENT_AGENT_TYPES = ["root", "subagent", "middleware", "compaction"] as const;

// Supported integrations and how each one merges metadata
export const CODING_AGENT_SCHEMA_INTEGRATIONS = [
  "claude-code",
  "openai-codex",
  "deepagents-code",
  "cursor",
  "pi",
] as const satisfies readonly CodingAgentSchemaIntegration[];
export const CODING_AGENT_CORE_INTEGRATIONS = [
  "claude-code",
  "cursor",
  "openai-codex",
] as const satisfies readonly CodingAgentIntegration[];
export const CODING_AGENT_CODEX_INTEGRATION = ["openai-codex"] as const;
export const CODING_AGENT_RUNTIME_NAMES = {
  "claude-code": "Claude Code",
  "openai-codex": "Codex",
  "deepagents-code": "Deep Agents Code",
  cursor: "Cursor",
  pi: "Pi",
} as const satisfies Readonly<Record<CodingAgentSchemaIntegration, string>>;
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
} as const satisfies Readonly<Record<CodingAgentIntegration, CodingAgentIntegrationPolicy>>;

// Default options for metadata fields
export const CODING_AGENT_ALWAYS_FIELD_OPTIONS = {
  requirement: "always",
} as const satisfies CodingAgentMetadataFieldOptions;
export const CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS = {
  requirement: "where_known",
  requiredWhereKnown: true,
} as const satisfies CodingAgentMetadataFieldOptions;
export const CODING_AGENT_FIELD_DEFAULTS = {
  appliesTo: CODING_AGENT_RUN_TYPES,
  type: "string",
  allowedValues: null,
  requirement: "contextual",
  requiredWhereKnown: false,
  metadataModeIntegrations: [],
} as const satisfies CodingAgentMetadataFieldOptions;
export const CODING_AGENT_STRUCTURAL_FIELD_DEFAULTS = {
  metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
  metadataSource: "structural",
} as const satisfies CodingAgentMetadataFieldOptions;
export const CODING_AGENT_PROVIDER_FIELD_DEFAULTS = {
  metadataSource: "provider",
  providerIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
} as const satisfies CodingAgentMetadataFieldOptions;

// Plugin inputs that become run metadata
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
] as const satisfies readonly (keyof CodingAgentMetadataOptions)[];
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
] as const satisfies readonly (readonly [keyof CodingAgentMetadataOptions, string])[];
export const TRUSTED_METADATA = Symbol("coding-agent trusted metadata");

// Muted traces, which keep metadata only
export const METADATA_MODE_NAME = "metadata";
export const METADATA_MODE_STATUS_VALUES = ["running", "completed", "error"] as const;

// SDK runtime details added to each run
export const CODING_AGENT_RUNTIME_LIBRARY = "langsmith";
export const CODING_AGENT_RUNTIME_SDK = "langsmith-js";
export const CODING_AGENT_RELEASE_ENVIRONMENT_VARIABLES = [
  "VERCEL_GIT_COMMIT_SHA",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA",
  "COMMIT_REF",
  "RENDER_GIT_COMMIT",
  "CI_COMMIT_SHA",
  "CIRCLE_SHA1",
  "CF_PAGES_COMMIT_SHA",
  "REACT_APP_GIT_SHA",
  "SOURCE_VERSION",
  "GITHUB_SHA",
  "TRAVIS_COMMIT",
  "GIT_COMMIT",
  "BUILD_VCS_NUMBER",
  "bamboo_planRepository_revision",
  "Build.SourceVersion",
  "BITBUCKET_COMMIT",
  "DRONE_COMMIT_SHA",
  "SEMAPHORE_GIT_SHA",
  "BUILDKITE_COMMIT",
] as const;

// Which environment variables are sent as metadata
export const CODING_AGENT_ENVIRONMENT_METADATA_PREFIXES = ["LANGCHAIN_", "LANGSMITH_"] as const;
export const CODING_AGENT_ENVIRONMENT_METADATA_EXCLUDED = [
  "LANGCHAIN_API_KEY",
  "LANGCHAIN_ENDPOINT",
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_PROJECT",
  "LANGCHAIN_SESSION",
  "LANGSMITH_API_KEY",
  "LANGSMITH_ENDPOINT",
  "LANGSMITH_TRACING_V2",
  "LANGSMITH_CONFIG_FILE",
  "LANGSMITH_PROJECT",
  "LANGSMITH_SESSION",
  "LANGSMITH_AGENT_ID",
  "LANGSMITH_AGENT_ENVIRONMENT",
] as const;
export const CODING_AGENT_ENVIRONMENT_METADATA_SENSITIVE_SUBSTRINGS = [
  "key",
  "secret",
  "token",
  "password",
  "passwd",
  "pwd",
  "credential",
  "email",
] as const;
export const CODING_AGENT_ENVIRONMENT_METADATA_ENDPOINT_SUBSTRINGS = [
  "endpoint",
  "proxy",
  "url",
  "auth",
  "header",
] as const;
export const CODING_AGENT_REVISION_ID_VARIABLE = "LANGCHAIN_REVISION_ID";
export const CODING_AGENT_REVISION_ID_KEY = "revision_id";
