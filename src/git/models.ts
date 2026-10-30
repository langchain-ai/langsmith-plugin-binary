import type { RepositoryAttribution } from "../metadata/models.js";
import type { ReconstructionToolOrigin } from "../tracing/reconstruction/models.js";
import type { GIT_MARKERS } from "./constants.js";

export interface GitRepositoryName {
  provider: string;
  name: string;
  host?: string;
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

export interface RepositoryAttributionSeed {
  roots: Record<string, string | null>;
  metadata: Record<string, RepositoryAttribution>;
  identifiers: Record<string, RepositoryAttribution>;
}

export interface RepositoryAttributorOptions {
  githubLoginMarkerPath: string;
  seed?: RepositoryAttributionSeed;
  skipGitHubLogin?: boolean;
}

export interface RepositoryAttributor {
  toolMetadata(
    base: Record<string, unknown> | undefined,
    origin: ReconstructionToolOrigin,
  ): Record<string, unknown> | undefined;
  turnMetadata(
    base: Record<string, unknown> | undefined,
    cwd: string | undefined,
    toolOrigins: Iterable<ReconstructionToolOrigin>,
  ): Record<string, unknown> | undefined;
}
