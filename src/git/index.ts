export { createGitHubLoginFallback } from "./github-login.js";
export { rootFromGitMarker } from "./paths.js";
export {
  getGitInfo,
  getGitUserName,
  getRepoName,
  getRepoRoot,
  getRepoUrl,
  parseRepoName,
} from "./repository.js";
export { nearestExistingDirectory } from "../utils/paths.js";
export type {
  GitHubLoginOptions,
  GitInfo,
  GitRepositoryName,
  GitUserNameOptions,
} from "./models.js";
