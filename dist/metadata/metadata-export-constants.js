export const TRUSTED_METADATA = Symbol("coding-agent trusted metadata");
export const METADATA_MODE_NAME = "metadata";
export const METADATA_MODE_STATUS_VALUES = ["running", "completed", "error"];
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
//# sourceMappingURL=metadata-export-constants.js.map