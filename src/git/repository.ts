import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  GIT_COMMAND_TIMEOUT_MS,
  GIT_LOCATION_ENV_KEYS,
  GIT_PROVIDERS,
  NOT_A_REPOSITORY,
  PROVIDER_HOSTS,
  REMOTE_GIT_SUFFIX,
  REMOTE_LINE_WHITESPACE,
  REMOTE_PATH_EDGE_SLASHES,
  REMOTE_PATH_TRAILING_SLASHES,
  SCP_REMOTE_PATTERN,
  GH_LOGIN_ARGUMENTS,
  GH_LOGIN_COMMAND,
  GH_LOGIN_TIMEOUT_MS,
  GH_LOGIN_PATTERN,
  GH_LOGIN_NULL_OUTPUT,
} from "./constants.js";
import type {
  GitCommandError,
  GitInfo,
  GitRemote,
  GitRepositoryName,
  GitUserNameOptions,
} from "./models.js";

export function parseRepoName(remoteUrl: string): GitRepositoryName | undefined {
  const value = remoteUrl.trim();
  try {
    const url = new URL(value);
    const provider = GIT_PROVIDERS[url.hostname.toLowerCase()];
    const name = url.pathname.replace(REMOTE_PATH_EDGE_SLASHES, "").replace(REMOTE_GIT_SUFFIX, "");
    if (provider && name) return { provider, name };
  } catch {}

  const scpMatch = value.match(SCP_REMOTE_PATTERN);
  if (scpMatch) {
    const host = scpMatch[1];
    const path = scpMatch[2];
    if (host && path) {
      const provider = GIT_PROVIDERS[host.toLowerCase()];
      const name = path.replace(REMOTE_PATH_TRAILING_SLASHES, "").replace(REMOTE_GIT_SUFFIX, "");
      if (provider && name) return { provider, name };
    }
  }
  return undefined;
}

function gitOutput(args: string[], cwd: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", LANG: "C" };
  for (const key of GIT_LOCATION_ENV_KEYS) delete env[key];
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf-8",
    timeout: GIT_COMMAND_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function getRepoName(cwd: string): GitRepositoryName | undefined {
  try {
    const output = gitOutput(["remote", "-v"], cwd);
    const lines = output.trim().split("\n").filter(Boolean);
    const remotes: GitRemote[] = [];
    for (const line of lines) {
      const parts = line.split(REMOTE_LINE_WHITESPACE);
      const name = parts[0];
      const url = parts[1];
      if (name && url && line.includes("(fetch)")) remotes.push({ name, url });
    }

    const origin = remotes.find((remote) => remote.name === "origin");
    if (origin) {
      const name = parseRepoName(origin.url);
      if (name) return name;
    }

    for (const remote of remotes) {
      const name = parseRepoName(remote.url);
      if (name) return name;
    }
  } catch {}
  return undefined;
}

export function getRepoUrl(provider: string, name: string): string | undefined {
  const host = PROVIDER_HOSTS[provider];
  return host ? `https://${host}/${name}` : undefined;
}

export function getRepoRoot(cwd: string): string | null | undefined {
  try {
    const root = gitOutput(["rev-parse", "--show-toplevel"], cwd).trim();
    return root ? resolve(root) : undefined;
  } catch (error) {
    const stderr = String((error as GitCommandError | undefined)?.stderr ?? "");
    return NOT_A_REPOSITORY.test(stderr) ? null : undefined;
  }
}

export function getGitUserName(cwd: string, options?: GitUserNameOptions): string | undefined {
  try {
    const name = gitOutput(["config", "user.name"], cwd).trim();
    if (name) return name;
  } catch {}
  return options?.githubLogin?.();
}

export function getGitInfo(cwd: string): GitInfo {
  const result: GitInfo = {};
  try {
    const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
    if (branch && branch !== "HEAD") result.branch = branch;
  } catch {}
  try {
    const commit = gitOutput(["rev-parse", "HEAD"], cwd).trim();
    if (commit) result.commit = commit;
  } catch {}
  return result;
}

export function githubLoginLookup(): string {
  return execFileSync(GH_LOGIN_COMMAND, GH_LOGIN_ARGUMENTS, {
    encoding: "utf-8",
    timeout: GH_LOGIN_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function isGitHubLogin(printed: string): boolean {
  return printed !== GH_LOGIN_NULL_OUTPUT && GH_LOGIN_PATTERN.test(printed);
}
