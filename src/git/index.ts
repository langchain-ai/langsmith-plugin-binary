export { captureRepositoryAttribution, createRepositoryAttributor } from "./attribution.js";
export { createGitHubLoginFallback } from "./github-login.js";
export { rootFromGitMarker } from "./paths.js";
export {
  getGitInfo,
  getGitUserName,
  getRepoName,
  getRepoRoot,
  getRepoUrl,
  getRepositoryMetadata,
  parseRepoName,
} from "./repository.js";
export { nearestExistingDirectory } from "../utils/paths.js";
export type {
  GitInfo,
  RepositoryAttributionSeed,
  RepositoryAttributor,
  RepositoryAttributorOptions,
} from "./models.js";
