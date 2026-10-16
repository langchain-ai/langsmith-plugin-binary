export { buildCodingAgentMetadata, trustedCodingAgentMetadata } from "./builder.js";
export {
  ATTRIBUTION_IDENTIFIER_KEY,
  CODING_AGENT_INTEGRATION_POLICIES,
  GIT_METADATA_KEYS,
  LEGACY_GIT_METADATA_KEYS,
  REPOSITORY_METADATA_KEYS,
} from "./constants.js";
export { withBothGitMetadataNames } from "./git-names.js";
export { buildCodingAgentRuntimeMetadata } from "./runtime.js";
export { prepareCodingAgentMetadataProvenance } from "./provenance.js";
export { metadataForMode, projectCodingAgentMetadata } from "./privacy.js";
export { normalizeProviderMetadata, validateProviderMetadata } from "./validation.js";
export type {
  CodingAgentAgentType,
  CodingAgentIntegration,
  CodingAgentMetadataMode,
  CodingAgentMetadataOptions,
  CodingAgentRunType,
  RepositoryAttribution,
} from "./models.js";
