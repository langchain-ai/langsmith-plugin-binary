import type { GIT_MARKERS } from "./constants.js";

export interface GitRepositoryName {
  provider: string;
  name: string;
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface GitCommandError {
  stderr?: unknown;
}

export interface GitInfo {
  branch?: string;
  commit?: string;
}

export interface GitUserNameOptions {
  githubLogin?: () => string | undefined;
}

export interface GitHubLoginMarker {
  failed: string;
}

export interface GitHubLoginOptions {
  markerPath: string;
  now?: () => number;
  retryAfterMs?: number;
}

export type GitMarker = (typeof GIT_MARKERS)[keyof typeof GIT_MARKERS];
