import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { nearestExistingDirectory } from "../utils/paths.js";
import {
  getGitInfo,
  getGitUserName,
  getRepoName,
  getRepoRoot,
  getRepoUrl,
  parseRepoName,
} from "./repository.js";
import { rootFromGitMarker } from "./paths.js";

const root = mkdtempSync(join(tmpdir(), "plugins-base git probe ; "));
const emptyConfig = join(root, "empty git config");
const repo = join(root, "repo with spaces ; [probe]");
const otherRepo = join(root, "other repo");
const env = {
  PATH: process.env.PATH ?? "",
  HOME: root,
  USERPROFILE: root,
  TMPDIR: tmpdir(),
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_SYSTEM: emptyConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  LANG: "C",
  LC_ALL: "C",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepo(directory: string, userName: string): void {
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "--quiet");
  git(directory, "checkout", "--quiet", "-b", "trunk");
  git(directory, "config", "user.name", userName);
  git(directory, "config", "user.email", "git-probe@example.test");
  writeFileSync(join(directory, "seed.txt"), "probe\n");
  git(directory, "add", "seed.txt");
  git(directory, "commit", "--quiet", "-m", "seed");
}

beforeAll(() => {
  writeFileSync(emptyConfig, "");
  makeRepo(repo, "Git Probe User");
  makeRepo(otherRepo, "Other Probe User");
  git(repo, "remote", "add", "upstream", "https://gitlab.com/acme/upstream.git");
  git(repo, "remote", "add", "origin", "https://user:password@github.com/acme/probe.git");
});

afterEach(() => vi.unstubAllEnvs());

describe("remote parsing", () => {
  it("excludes credentials from recognized repository paths", () => {
    const urls = [
      "https://username:password@github.com/langchain-ai/example.git",
      "http://username:password@gitlab.com/langchain-ai/example.git",
      "ssh://username:password@bitbucket.org/langchain-ai/example.git",
      "ssh://username:password@github.com:2222/langchain-ai/example.git",
    ];
    for (const url of urls) expect(parseRepoName(url)?.name).toBe("langchain-ai/example");
  });

  it("parses SCP-style SSH remotes", () => {
    expect(parseRepoName("git@github.com:langchain-ai/example.git")).toEqual({
      provider: "github",
      name: "langchain-ai/example",
    });
  });
});

describe("repository probes", () => {
  it("reads repository identity and Git details from a path with shell punctuation", () => {
    const nested = join(repo, "not created", "deep", "file.txt");
    const existing = join(repo, "existing subdirectory");
    const fallback = vi.fn(() => "github-user");
    const commit = git(repo, "rev-parse", "HEAD");
    mkdirSync(existing);

    expect(nearestExistingDirectory(nested)).toBe(repo);
    expect(rootFromGitMarker(nested)).toBe(repo);
    expect(getRepoRoot(existing)).toBe(repo);
    expect(getRepoName(repo)).toEqual({ provider: "github", name: "acme/probe" });
    expect(getRepoUrl("github", "acme/probe")).toBe("https://github.com/acme/probe");
    expect(getRepoUrl("unknown", "acme/probe")).toBeUndefined();
    expect(getGitInfo(repo)).toEqual({ branch: "trunk", commit });
    expect(getGitUserName(repo, { githubLogin: fallback })).toBe("Git Probe User");
    expect(fallback).not.toHaveBeenCalled();
    git(repo, "config", "--unset", "user.name");
    expect(getGitUserName(repo, { githubLogin: fallback })).toBe("github-user");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("ignores Git location variables inherited from another repository", () => {
    vi.stubEnv("HOME", root);
    vi.stubEnv("GIT_DIR", join(otherRepo, ".git"));
    vi.stubEnv("GIT_WORK_TREE", otherRepo);
    vi.stubEnv("GIT_COMMON_DIR", join(otherRepo, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", join(otherRepo, ".git", "index"));
    vi.stubEnv("GIT_CEILING_DIRECTORIES", otherRepo);

    expect(getRepoRoot(repo)).toBe(repo);
    expect(getGitInfo(repo).branch).toBe("trunk");
  });

  it("leaves non-repository and unreadable paths distinct", () => {
    const plain = join(root, "plain folder");
    mkdirSync(plain);

    expect(rootFromGitMarker(plain)).toBeNull();
    expect(getRepoRoot(plain)).toBeNull();
    expect(getRepoRoot(join(root, "missing folder"))).toBeUndefined();
  });

  it("uses Git for a worktree whose root marker is a file", () => {
    const worktree = join(root, "worktree with spaces ; [probe]");
    git(repo, "worktree", "add", "--quiet", "--detach", worktree);

    expect(rootFromGitMarker(worktree)).toBeUndefined();
    expect(getRepoRoot(worktree)).toBe(worktree);
    expect(getGitInfo(worktree)).toEqual({ commit: git(repo, "rev-parse", "HEAD") });
  });

  it("uses a known remote when origin cannot be parsed", () => {
    git(repo, "remote", "set-url", "origin", "local:acme/probe");

    expect(getRepoName(repo)).toEqual({ provider: "gitlab", name: "acme/upstream" });
  });
});
