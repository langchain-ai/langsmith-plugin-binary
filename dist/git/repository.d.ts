import type { GitInfo, GitRepositoryName, GitUserNameOptions } from "./models.js";
import type { RepositoryAttribution } from "../metadata/models.js";
export declare function parseRepoName(remoteUrl: string): GitRepositoryName | undefined;
export declare function getRepoName(cwd: string): GitRepositoryName | undefined;
export declare function getRepoUrl(provider: string, name: string): string | undefined;
export declare function getRepoRoot(cwd: string): string | null | undefined;
export declare function getGitUserName(cwd: string, options?: GitUserNameOptions): string | undefined;
export declare function getGitInfo(cwd: string): GitInfo;
export declare function getRepositoryMetadata(cwd: string): RepositoryAttribution;
export declare function githubLoginLookup(): string;
export declare function isGitHubLogin(printed: string): boolean;
//# sourceMappingURL=repository.d.ts.map