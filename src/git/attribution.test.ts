import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconstructionToolOrigin } from "../tracing/reconstruction/models.js";
import { createRepositoryAttributor } from "./attribution.js";
import { fakeTool } from "../test-support/login.js";
import type { RepositoryAttributor } from "./models.js";

vi.mock("node:child_process", { spy: true });

const { execFileSync: realExecFileSync } =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

const INSTALLED_GH = fakeTool(process.platform === "win32" ? "gh.exe" : "gh");

function answerGitHubLogin(printed: string): void {
  vi.mocked(execFileSync).mockImplementation(((
    file: string,
    args: readonly string[],
    options: object,
  ) =>
    file.startsWith(INSTALLED_GH)
      ? printed
      : realExecFileSync(file, args, options)) as typeof execFileSync);
  vi.stubEnv("PATH", `${INSTALLED_GH}${delimiter}${process.env.PATH ?? ""}`);
}

const root = mkdtempSync(join(tmpdir(), "plugins-base attribution "));
const globalConfig = join(root, "global config");
writeFileSync(globalConfig, "[user]\n\tname = Global Fallback\n");
const sandboxEnv = { HOME: root, USERPROFILE: root, GIT_CONFIG_GLOBAL: globalConfig };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...sandboxEnv },
  }).trim();
}

function makeDir(...segments: string[]): string {
  const path = join(...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

function makeRepo(name: string, branch: string, user: string, remote?: string): string {
  const path = makeDir(root, name);
  git(path, "init", "--initial-branch", branch);
  git(path, "config", "user.name", user);
  git(path, "config", "user.email", `${branch}@example.test`);
  if (remote) git(path, "remote", "add", "origin", remote);
  writeFileSync(join(path, "seed.txt"), "seed\n");
  git(path, "add", "seed.txt");
  git(path, "commit", "-m", "Seed");
  return path;
}

const alpha = makeRepo("alpha repo", "trunk-alpha", "Alpha Owner", "git@github.com:acme/alpha.git");
const beta = makeRepo("beta repo", "trunk-beta", "Beta Owner", "https://gitlab.com/acme/beta.git");
const selfHosted = makeRepo(
  "self hosted repo",
  "trunk-ghe",
  "Enterprise Owner",
  "git@github.mycorp.com:acme/ghe.git",
);
const remoteless = makeRepo("remoteless repo", "trunk-local", "Local Owner");
const nameless = makeRepo("nameless repo", "trunk-nameless", "Temporary");
git(nameless, "config", "--unset", "user.name");
const plain = makeDir(root, "plain folder");
const nested = join(makeDir(alpha, "sub dir"), "nested.txt");
const betaNested = join(makeDir(beta, "sub dir"), "nested.txt");
for (const path of [nested, betaNested]) writeFileSync(path, "nested\n");
const worktree = join(root, "alpha worktree");
git(alpha, "worktree", "add", "-b", "side-branch", worktree);
const submodule = makeDir(alpha, "broken submodule");
writeFileSync(join(submodule, ".git"), `gitdir: ${join(alpha, ".git", "modules", "gone")}\n`);
const markerPath = join(root, "plugin state", "langsmith_gh_login.json");

const alphaSeed = join(alpha, "seed.txt");
const betaSeed = join(beta, "seed.txt");
const central = "/somewhere/central";
const gitCommands = () =>
  vi.mocked(execFileSync).mock.calls.map(([file, args]) => [file, ...(args ?? [])].join(" "));

// What a plugin loads without git for a session started outside every repository.
const base = { cwd: central, ls_integration: "claude-code" };
const inAlpha = { ls_git_repo: "acme/alpha", ls_attribution_identifier: "Alpha Owner" };
const inBeta = { ls_git_repo: "acme/beta" };
const everythingAlphaReveals = {
  ls_git_repo: "acme/alpha",
  ls_repo_provider: "github",
  ls_git_repo_url: "https://github.com/acme/alpha",
  ls_git_branch: "trunk-alpha",
  ls_git_commit_hash: git(alpha, "rev-parse", "HEAD"),
  repository_name: "acme/alpha",
  repository_provider: "github",
  repository_url: "https://github.com/acme/alpha",
  git_branch: "trunk-alpha",
  git_commit_sha: git(alpha, "rev-parse", "HEAD"),
  ls_attribution_identifier: "Alpha Owner",
};
const everythingBetaReveals = {
  ...inBeta,
  ls_repo_provider: "gitlab",
  ls_git_repo_url: "https://gitlab.com/acme/beta",
  ls_git_branch: "trunk-beta",
  ls_git_commit_hash: git(beta, "rev-parse", "HEAD"),
  repository_name: "acme/beta",
  repository_provider: "gitlab",
  repository_url: "https://gitlab.com/acme/beta",
  git_branch: "trunk-beta",
  git_commit_sha: git(beta, "rev-parse", "HEAD"),
  ls_attribution_identifier: "Beta Owner",
};

type Row = Record<string, unknown>;
type Case = [name: string, origin: ReconstructionToolOrigin, want: Row];

const file = (path: string, cwd = central): ReconstructionToolOrigin => ({
  path,
  cwd,
  namedAPath: true,
});

let attributor: RepositoryAttributor;

beforeEach(() => {
  for (const [key, value] of Object.entries(sandboxEnv)) vi.stubEnv(key, value);
  attributor = createRepositoryAttributor({ githubLoginMarkerPath: markerPath });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(execFileSync).mockImplementation(realExecFileSync);
});

describe("toolMetadata", () => {
  it.each<Case>([
    ["a file in another repository", file(betaSeed), { ...base, ...everythingBetaReveals }],
    [
      "a shell command run in a repository",
      { cwd: beta, namedAPath: false },
      { ...base, cwd: beta, ...everythingBetaReveals },
    ],
    [
      "a repository with no recognized remote, which still has an author",
      file(join(remoteless, "seed.txt")),
      {
        ...base,
        ls_git_branch: "trunk-local",
        ls_git_commit_hash: git(remoteless, "rev-parse", "HEAD"),
        git_branch: "trunk-local",
        git_commit_sha: git(remoteless, "rev-parse", "HEAD"),
        ls_attribution_identifier: "Local Owner",
      },
    ],
    ["a path git places in no repository", file(join(plain, "x.txt")), base],
    ["an opaque identifier no file sits at", { cwd: central, namedAPath: true }, base],
    ["a broken submodule git cannot answer for", file(join(submodule, "x.txt")), base],
    [
      "a relative path, which says nothing on its own",
      file(relative(process.cwd(), betaSeed)),
      base,
    ],
  ])("stamps exactly what %s accounts for", (_name, origin, want) => {
    expect(attributor.toolMetadata({ ...base, cwd: origin.cwd }, origin)).toEqual({
      ...want,
      cwd: origin.cwd,
    });
  });

  it.each<Case>([
    ["a file nothing has created yet", file(join(alpha, "new", "deep", "x.txt")), inAlpha],
    ["a file in the git directory", file(join(alpha, ".git", "config")), inAlpha],
    [
      "a linked worktree, on its own branch rather than the main checkout's",
      file(join(worktree, "seed.txt")),
      { ls_git_repo: "acme/alpha", ls_git_branch: "side-branch" },
    ],
  ])("attributes %s", (_name, origin, want) => {
    expect(attributor.toolMetadata(base, origin)).toMatchObject(want);
  });

  it("names a repository on a self-hosted server", () => {
    expect(attributor.toolMetadata(base, file(join(selfHosted, "seed.txt")))).toMatchObject({
      ls_git_repo: "acme/ghe",
      ls_repo_provider: "github",
      ls_git_repo_url: "https://github.mycorp.com/acme/ghe",
      ls_attribution_identifier: "Enterprise Owner",
    });
  });

  it("asks git nothing to place more paths in a linked worktree", () => {
    const folders = ["one", "two"].map((name) => makeDir(worktree, "places", name));
    attributor.toolMetadata(base, file(join(folders[0]!, "x.txt")));
    const afterFirstFolder = gitCommands().length;

    expect(attributor.toolMetadata(base, file(join(folders[1]!, "x.txt")))).toMatchObject({
      ls_git_branch: "side-branch",
    });
    expect(gitCommands()).toHaveLength(afterFirstFolder);
  });

  it("gives a tool inside the session's own repository the session repository and author", () => {
    expect(attributor.toolMetadata(base, file(alphaSeed, alpha))).toEqual({
      ...everythingAlphaReveals,
      ...base,
    });
    expect(attributor.toolMetadata(base, { cwd: alpha, namedAPath: true })).toEqual({
      ...everythingAlphaReveals,
      ...base,
    });
  });

  it("gives each tool its own repository rather than the session's", () => {
    expect(attributor.toolMetadata(base, file(betaSeed, alpha))).toEqual({
      ...base,
      ...everythingBetaReveals,
    });
    expect(attributor.toolMetadata(base, file(join(plain, "x.txt"), alpha))).toEqual(base);
  });

  it("keeps a repository name and author the person configured wherever a tool reaches", () => {
    const pinned = { ...base, ls_git_repo: "acme/pinned", ls_attribution_identifier: "Chosen" };

    for (const path of [alphaSeed, betaSeed, join(plain, "x.txt")]) {
      expect(attributor.toolMetadata(pinned, file(path, alpha))).toMatchObject({
        ls_git_repo: "acme/pinned",
        ls_attribution_identifier: "Chosen",
      });
    }
    expect(attributor.toolMetadata(pinned, file(betaSeed, alpha))).toMatchObject({
      ls_git_branch: "trunk-beta",
    });
  });

  it("ignores git settings the session exported, which answer for the wrong directory", () => {
    vi.stubEnv("GIT_DIR", join(alpha, ".git"));
    vi.stubEnv("GIT_CEILING_DIRECTORIES", beta);

    for (const path of [betaSeed, betaNested]) {
      expect(attributor.toolMetadata(base, file(path))).toMatchObject(inBeta);
    }
  });

  it("runs git once per repository however many of its paths a turn touches", () => {
    const first = attributor.toolMetadata(base, file(alphaSeed));
    const afterFirstPath = gitCommands().length;
    expect(afterFirstPath).toBeGreaterThan(0);

    for (const path of [nested, alphaSeed]) {
      expect(attributor.toolMetadata(base, file(path))).toEqual(first);
      expect(gitCommands()).toHaveLength(afterFirstPath);
    }

    const inOwnRepository = attributor.toolMetadata(base, file(alphaSeed, alpha));
    const broken = attributor.toolMetadata(base, file(join(submodule, "x.txt")));
    const afterEveryKind = gitCommands().length;
    expect(attributor.toolMetadata(base, file(nested, alpha))).toEqual(inOwnRepository);
    expect(attributor.toolMetadata(base, file(join(submodule, "y.txt")))).toEqual(broken);
    expect(gitCommands()).toHaveLength(afterEveryKind);
  });

  it("asks git nothing to place a path, so only naming a repository costs a process", () => {
    expect(attributor.toolMetadata(base, file(join(plain, "x.txt")))).toEqual(base);
    expect(gitCommands()).toEqual([]);
  });

  it("falls back to the GitHub login and keeps its failure where the plugin said", () => {
    answerGitHubLogin("null");
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "missing config"));

    expect(attributor.toolMetadata(base, file(join(nameless, "seed.txt")))).not.toHaveProperty(
      "ls_attribution_identifier",
    );
    expect(existsSync(markerPath)).toBe(true);

    answerGitHubLogin("signed-in-user");
    const later = createRepositoryAttributor({
      githubLoginMarkerPath: join(root, "other state", "login.json"),
    });
    expect(later.toolMetadata(base, file(join(nameless, "seed.txt")))).toMatchObject({
      ls_attribution_identifier: "signed-in-user",
    });
  });
});

describe("turnMetadata", () => {
  const pathless: ReconstructionToolOrigin = { cwd: central, namedAPath: false };
  const outside = file(join(plain, "x.txt"));

  it("gives a turn in a repository that repository and its author, whatever its tools touched", () => {
    expect(attributor.turnMetadata({ ...base, cwd: alpha }, alpha, [file(betaSeed)])).toEqual({
      ...everythingAlphaReveals,
      ...base,
      cwd: alpha,
    });
  });

  it("gives a turn outside every repository the repository its first landing tool is in", () => {
    expect(
      attributor.turnMetadata(base, central, [pathless, outside, file(betaSeed), file(alphaSeed)]),
    ).toEqual({ ...base, ...everythingBetaReveals });
  });

  it("leaves a turn whose tools landed in no repository as it was", () => {
    expect(attributor.turnMetadata(base, central, [pathless, outside])).toBe(base);
    expect(attributor.turnMetadata(base, undefined, [])).toBe(base);
  });

  it("keeps an author the person configured rather than the one git reports", () => {
    const chosen = { ...base, cwd: alpha, ls_attribution_identifier: "Chosen" };

    expect(attributor.turnMetadata(chosen, alpha, [])).toMatchObject({
      ls_git_repo: "acme/alpha",
      ls_attribution_identifier: "Chosen",
    });
  });
});
