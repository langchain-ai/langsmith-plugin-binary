import { CODING_AGENT_V1_CONTRACT } from "./contract.js";
function forwardsEnvironmentVariable(name, value, environmentMetadata) {
    return (typeof value === "string" &&
        environmentMetadata.prefixes.some((prefix) => name.startsWith(prefix)) &&
        !environmentMetadata.excluded.includes(name) &&
        ![...environmentMetadata.sensitiveSubstrings, ...environmentMetadata.endpointSubstrings].some((part) => name.toLowerCase().includes(part)));
}
export function buildCodingAgentRuntimeMetadata(options) {
    const { library, sdk, releaseEnvironmentVariables, environmentMetadata } = CODING_AGENT_V1_CONTRACT.runtime;
    const runtime = {
        library,
        runtime: options.runtime,
        sdk,
        sdk_version: options.sdkVersion,
    };
    for (const name of releaseEnvironmentVariables) {
        const value = options.env[name];
        if (value !== undefined)
            runtime[name] = value;
    }
    const metadata = {};
    for (const [name, value] of Object.entries(options.env)) {
        if (!forwardsEnvironmentVariable(name, value, environmentMetadata))
            continue;
        metadata[name === environmentMetadata.revisionId.variable ? environmentMetadata.revisionId.key : name] = value;
    }
    return { runtime, metadata };
}
//# sourceMappingURL=runtime.js.map