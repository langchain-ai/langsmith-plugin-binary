import { canonicalJsonObject, ownDataField, requirePlainRecord, } from "../utils/validation/objects.js";
import { CODING_AGENT_AGENT_TYPES, CODING_AGENT_RUN_TYPES } from "./constants.js";
import { CODING_AGENT_METADATA_PROJECTION_FIELDS, CODING_AGENT_METADATA_PROVENANCE_FIELDS, } from "./constants.js";
import { buildCodingAgentMetadata } from "./builder.js";
import { metadataForMode } from "./privacy.js";
import { normalizeProviderMetadata } from "./validation.js";
export function prepareCodingAgentMetadataProvenance(value, integration, mode, status = "running") {
    const source = requirePlainRecord(value, "Run metadata");
    const declaredIntegration = ownDataField(source, "integration");
    if (declaredIntegration.present && declaredIntegration.value !== integration) {
        throw new TypeError("Run metadata integration does not match the lifecycle bridge");
    }
    const selected = {};
    for (const key of CODING_AGENT_METADATA_PROVENANCE_FIELDS) {
        const field = ownDataField(source, key);
        if (field.present && field.value !== undefined)
            selected[key] = field.value;
    }
    selected["integration"] = integration;
    const threadId = selected["threadId"];
    if (typeof threadId !== "string" || threadId.trim().length === 0)
        return { status: "deferred" };
    const agentType = selected["agentType"];
    if (typeof agentType !== "string" ||
        !CODING_AGENT_AGENT_TYPES.includes(agentType)) {
        throw new TypeError("Run metadata has an invalid agent type");
    }
    const runType = selected["runType"];
    if (typeof runType !== "string" ||
        !CODING_AGENT_RUN_TYPES.includes(runType)) {
        throw new TypeError("Run metadata has an invalid run type");
    }
    for (const key of ["usageMetadata", "providerMetadata", "runSpecific", "base"]) {
        if (selected[key] !== undefined)
            selected[key] = canonicalJsonObject(selected[key], `Run metadata ${key}`);
    }
    selected["providerMetadata"] = normalizeProviderMetadata(selected["providerMetadata"], integration, runType);
    if (mode === "metadata") {
        delete selected["base"];
        delete selected["runSpecific"];
    }
    const options = selected;
    return {
        status: "ready",
        value: mode === "metadata" ? projectMetadataProvenance(options, integration, status) : options,
    };
}
function projectMetadataProvenance(options, integration, status) {
    const projection = metadataForMode(buildCodingAgentMetadata(options), integration, "metadata", status) ?? {};
    const safe = {
        integration,
        threadId: projectedString(projection, "thread_id"),
        agentType: projectedString(projection, "ls_agent_type"),
        runType: options.runType,
    };
    for (const [optionKey, metadataKey] of CODING_AGENT_METADATA_PROJECTION_FIELDS) {
        if (Object.hasOwn(projection, metadataKey))
            safe[optionKey] = projection[metadataKey];
    }
    if (options.clearSubagent === true)
        safe["clearSubagent"] = true;
    if (typeof options.toolName === "string" &&
        (projection["ls_tool_name"] === options.toolName ||
            projection["tool_name"] === options.toolName)) {
        safe["toolName"] = options.toolName;
        if (typeof options.runName === "string")
            safe["runName"] = options.runName;
    }
    if (Object.hasOwn(projection, "usage_metadata"))
        safe["usageMetadata"] = projection["usage_metadata"];
    const provider = normalizeProviderMetadata(options.providerMetadata, integration, options.runType);
    const allowedProvider = Object.fromEntries(Object.entries(provider).filter(([key]) => Object.hasOwn(projection, key)));
    if (Object.keys(allowedProvider).length > 0)
        safe["providerMetadata"] = allowedProvider;
    return safe;
}
function projectedString(source, key) {
    const value = source[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`Metadata projection ${key} is required`);
    }
    return value;
}
//# sourceMappingURL=provenance.js.map