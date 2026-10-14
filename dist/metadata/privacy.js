import { CODING_AGENT_INTEGRATION_POLICIES, METADATA_MODE_NAME, METADATA_MODE_STATUS_VALUES, } from "./constants.js";
import { CODING_AGENT_V1_CONTRACT } from "./contract.js";
import { trustedCodingAgentMetadata } from "./builder.js";
import { metadataFieldTypeIssue } from "./validation.js";
export function projectCodingAgentMetadata(metadata, integration, status) {
    const safe = {};
    for (const [key, value] of Object.entries(metadata ?? {})) {
        const field = CODING_AGENT_V1_CONTRACT.keys.find((entry) => entry.key === key);
        if (!field?.metadataModeIntegrations.includes(integration) ||
            value === undefined ||
            metadataFieldTypeIssue(field, value) !== undefined) {
            continue;
        }
        safe[key] = value;
    }
    safe.status = METADATA_MODE_STATUS_VALUES.includes(status)
        ? status
        : "running";
    safe.ls_tracing_mode = METADATA_MODE_NAME;
    return safe;
}
export function metadataForMode(metadata, integration, mode = "full", status) {
    if (mode === "full")
        return metadata;
    const trusted = trustedCodingAgentMetadata(metadata);
    const source = trusted ??
        (CODING_AGENT_INTEGRATION_POLICIES[integration].metadataModeUsesDirectMetadata
            ? metadata
            : undefined);
    return projectCodingAgentMetadata(source, integration, status);
}
//# sourceMappingURL=privacy.js.map