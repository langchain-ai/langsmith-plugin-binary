import { CODING_AGENT_V1_CONTRACT } from "./contract.js";
import type {
  CodingAgentEnvironmentMetadataContract,
  CodingAgentRuntimeMetadata,
  CodingAgentRuntimeOptions,
} from "./models.js";

function forwardsEnvironmentVariable(
  name: string,
  value: string | undefined,
  environmentMetadata: CodingAgentEnvironmentMetadataContract,
): value is string {
  return (
    typeof value === "string" &&
    environmentMetadata.prefixes.some((prefix) => name.startsWith(prefix)) &&
    !environmentMetadata.excluded.includes(name) &&
    ![...environmentMetadata.sensitiveSubstrings, ...environmentMetadata.endpointSubstrings].some(
      (part) => name.toLowerCase().includes(part),
    )
  );
}

export function buildCodingAgentRuntimeMetadata(
  options: CodingAgentRuntimeOptions,
): CodingAgentRuntimeMetadata {
  const { library, sdk, releaseEnvironmentVariables, environmentMetadata } =
    CODING_AGENT_V1_CONTRACT.runtime;
  const runtime: Record<string, string> = {
    library,
    runtime: options.runtime,
    sdk,
    sdk_version: options.sdkVersion,
  };
  for (const name of releaseEnvironmentVariables) {
    const value = options.env[name];
    if (value !== undefined) runtime[name] = value;
  }
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env)) {
    if (!forwardsEnvironmentVariable(name, value, environmentMetadata)) continue;
    metadata[
      name === environmentMetadata.revisionId.variable ? environmentMetadata.revisionId.key : name
    ] = value;
  }
  return { runtime, metadata };
}
