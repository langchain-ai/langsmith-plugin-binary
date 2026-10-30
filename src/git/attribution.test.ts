import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconstructionToolOrigin } from "../tracing/reconstruction/models.js";
import { createRepositoryAttributor, snapshotRepositories } from "./attribution.js";
import { fakeTool } from "../test-support/login.js";
import type { RepositoryAttributor, RepositorySnapshot } from "./models.js";
import { getGitUserName, getRepositoryMetadata } from "./repository.js";

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

function moveOn(repo: string, branch: string, user: string): string {
  git(repo, "checkout", "-q", "-b", branch);
  git(repo, "config", "user.name", user);
  git(repo, "commit", "-q", "--allow-empty", "-m", branch);
  return git(repo, "rev-parse", "HEAD");
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
const packed = makeRepo(
  "packed repo",
  "trunk-packed",
  "Packed Owner",
  "https://github.com/acme/packed.git",
);
git(packed, "pack-refs", "--all");
const detached = makeRepo("detached repo", "trunk-detached", "Detached Owner");
git(detached, "checkout", "-q", "--detach");

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

function readThroughSnapshot(repository: string): {
  snapshot: RepositorySnapshot;
  commands: string[];
} {
  const before = gitCommands().length;
  const snapshot = snapshotRepositories(beta, [file(join(repository, "seed.txt"), beta)]);
  return { snapshot, commands: gitCommands().slice(before) };
}

function expectGitsOwnAnswer(snapshot: RepositorySnapshot, repository: string): void {
  expect(snapshot.repositories[repository]).toEqual(getRepositoryMetadata(repository));
  const name = getGitUserName(repository);
  expect(snapshot.identifiers[repository]).toEqual(
    name ? { ls_attribution_identifier: name } : undefined,
  );
}

describe("snapshotRepositories", () => {
  const options = { githubLoginMarkerPath: markerPath };

  it("keeps the branch, commit and author a turn ended on after the repositories move on", () => {
    const own = makeRepo(
      "snapshot own repo",
      "turn-one",
      "First Author",
      "git@github.com:acme/own.git",
    );
    const other = makeRepo("snapshot other repo", "other-one", "Other Author");
    const otherFile = file(join(other, "seed.txt"), own);
    const ownCommit = git(own, "rev-parse", "HEAD");
    const otherCommit = git(other, "rev-parse", "HEAD");
    const snapshot = JSON.parse(
      JSON.stringify(snapshotRepositories(own, [otherFile])),
    ) as ReturnType<typeof snapshotRepositories>;

    const laterOwnCommit = moveOn(own, "turn-two", "Second Author");
    moveOn(other, "other-two", "Later Author");
    const atTurnEnd = createRepositoryAttributor({ ...options, snapshot });
    const now = createRepositoryAttributor(options);

    expect(atTurnEnd.turnMetadata(base, own, [])).toMatchObject({
      ls_git_repo: "acme/own",
      ls_git_branch: "turn-one",
      ls_git_commit_hash: ownCommit,
      ls_attribution_identifier: "First Author",
    });
    expect(atTurnEnd.toolMetadata(base, otherFile)).toMatchObject({
      ls_git_branch: "other-one",
      ls_git_commit_hash: otherCommit,
      ls_attribution_identifier: "Other Author",
    });
    expect(now.turnMetadata(base, own, [])).toMatchObject({
      ls_git_branch: "turn-two",
      ls_git_commit_hash: laterOwnCommit,
      ls_attribution_identifier: "Second Author",
    });
  });

  it("keeps a turn outside every repository there after its folder becomes one", () => {
    const folder = makeDir(root, "snapshot later repo");
    const snapshot = snapshotRepositories(folder);
    git(folder, "init", "-q");

    expect(
      createRepositoryAttributor({ ...options, snapshot }).turnMetadata(base, folder, []),
    ).toBe(base);
  });

  it("never asks GitHub for the author, leaving that to the uploader", () => {
    answerGitHubLogin("signed-in-user");
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "missing config"));

    const snapshot = snapshotRepositories(nameless);
    expect(gitCommands().filter((command) => command.startsWith(INSTALLED_GH))).toEqual([]);

    const uploader = createRepositoryAttributor({
      githubLoginMarkerPath: join(root, "uploader state", "login.json"),
      snapshot,
    });
    expect(uploader.turnMetadata(base, nameless, [])).toMatchObject({
      ls_git_branch: "trunk-nameless",
      ls_attribution_identifier: "signed-in-user",
    });
  });

  it.each<[name: string, repository: () => string]>([
    ["a normal checkout", () => alpha],
    ["a linked worktree", () => worktree],
    ["a branch whose ref is packed", () => packed],
    ["a detached HEAD", () => detached],
    ["a repository with no remote", () => remoteless],
    ["an author set only in the global config", () => nameless],
    [
      "a SHA-256 repository",
      () => {
        const path = makeDir(root, "sha256 repo");
        git(path, "init", "-q", "--object-format=sha256", "--initial-branch", "trunk-sha256");
        git(path, "config", "user.name", "Long Hash Owner");
        writeFileSync(join(path, "seed.txt"), "seed\n");
        git(path, "add", "seed.txt");
        git(path, "-c", "user.email=s@example.test", "commit", "-q", "-m", "Seed");
        return path;
      },
    ],
    [
      "an author with a tab inside",
      () => {
        const path = makeRepo("tabbed repo", "trunk-tabbed", "Temporary");
        git(path, "config", "--unset", "user.name");
        appendFileSync(join(path, ".git", "config"), "[user]\n\tname = Tabbed\tOwner\n");
        return path;
      },
    ],
  ])("reads %s as git does with one shared config listing", (_name, repository) => {
    const path = repository();
    const { snapshot, commands } = readThroughSnapshot(path);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("config --list");
    expectGitsOwnAnswer(snapshot, path);
  });

  it.each<[name: string, prepare: (repository: string) => void]>([
    [
      "a remote rewritten by insteadOf",
      (repository) =>
        git(
          repository,
          "config",
          "url.https://github.com/acme/real.insteadOf",
          "https://github.com/acme/fake",
        ),
    ],
    [
      "a remote rewritten in a system config git still reads",
      () => {
        const system = join(root, "system config");
        writeFileSync(
          system,
          '[url "https://github.com/acme/real"]\n\tinsteadOf = https://github.com/acme/fake\n',
        );
        vi.stubEnv("GIT_CONFIG_SYSTEM", system);
        vi.stubEnv("GIT_CONFIG_NOSYSTEM", "0");
      },
    ],
    [
      "an author from an included file",
      (repository) => {
        const included = join(root, "included config");
        writeFileSync(included, "[user]\n\tname = Included Owner\n");
        git(repository, "config", "include.path", included);
      },
    ],
    [
      "an author from a global include that applies to this folder only",
      (repository) => {
        const included = join(root, "conditional config");
        const global = join(root, "conditional global");
        writeFileSync(included, "[user]\n\tname = Conditional Owner\n");
        writeFileSync(
          global,
          `[includeIf "gitdir:${realpathSync(repository).replaceAll("\\", "/")}/"]\n\tpath = ${included.replaceAll("\\", "/")}\n`,
        );
        vi.stubEnv("GIT_CONFIG_GLOBAL", global);
        git(repository, "config", "--unset", "user.name");
      },
    ],
    ["a quoted author", (repository) => git(repository, "config", "user.name", "Quoted # Owner")],
    [
      "an author set by the environment",
      () => {
        vi.stubEnv("GIT_CONFIG_COUNT", "1");
        vi.stubEnv("GIT_CONFIG_KEY_0", "user.name");
        vi.stubEnv("GIT_CONFIG_VALUE_0", "Environment Owner");
      },
    ],
    [
      "an author set for this worktree only",
      (repository) => {
        git(repository, "config", "extensions.worktreeConfig", "true");
        git(repository, "config", "--worktree", "user.name", "Worktree Owner");
      },
    ],
    ["a branch named like a tag", (repository) => git(repository, "tag", "trunk-guarded")],
    [
      "a branch that points at another branch",
      (repository) => {
        git(repository, "branch", "real-branch");
        git(repository, "symbolic-ref", "refs/heads/alias", "refs/heads/real-branch");
        git(repository, "symbolic-ref", "HEAD", "refs/heads/alias");
      },
    ],
    [
      "packed refs too large to read faster than git",
      (repository) => {
        git(repository, "pack-refs", "--all");
        const head = git(repository, "rev-parse", "HEAD");
        const filler = Array.from(
          { length: 20_000 },
          (_, index) => `${head} refs/tags/filler-${index}`,
        );
        appendFileSync(join(repository, ".git", "packed-refs"), `${filler.join("\n")}\n`);
      },
    ],
  ])("answers %s exactly as git does", (name, prepare) => {
    const repository = makeRepo(
      `guarded ${name}`,
      "trunk-guarded",
      "Guarded Owner",
      "https://github.com/acme/fake.git",
    );
    prepare(repository);
    const { snapshot } = readThroughSnapshot(repository);

    expectGitsOwnAnswer(snapshot, repository);
  });

  it("leaves packed refs too large to beat git to git", () => {
    const repository = makeRepo("huge packed repo", "trunk-huge", "Huge Owner");
    git(repository, "pack-refs", "--all");
    const head = git(repository, "rev-parse", "HEAD");
    const filler = Array.from(
      { length: 20_000 },
      (_, index) => `${head} refs/tags/filler-${index}`,
    );
    appendFileSync(join(repository, ".git", "packed-refs"), `${filler.join("\n")}\n`);

    expect(
      readThroughSnapshot(repository).commands.some((command) => command.includes("rev-parse")),
    ).toBe(true);
  });

  it("keeps the repository of a worktree deleted before the upload", () => {
    const home = makeRepo(
      "worktree home",
      "trunk-home",
      "Home Owner",
      "https://github.com/acme/home.git",
    );
    const tree = join(root, "short lived worktree");
    git(home, "worktree", "add", "-q", "-b", "short-lived", tree);
    const touched = file(join(tree, "seed.txt"), tree);
    const snapshot = snapshotRepositories(tree, [touched]);
    git(home, "worktree", "remove", tree);

    expect(
      createRepositoryAttributor({ ...options, snapshot }).turnMetadata(base, tree, [touched]),
    ).toMatchObject({
      ls_git_repo: "acme/home",
      ls_git_branch: "short-lived",
    });
  });

  it("reads at most ten tool repositories, leaving the rest to the uploader", () => {
    const template = makeRepo("capped template", "trunk-capped", "Capped Owner");
    const repositories = Array.from({ length: 12 }, (_, index) => {
      const copy = join(root, `capped ${index}`);
      cpSync(template, copy, { recursive: true });
      return copy;
    });
    const snapshot = snapshotRepositories(
      central,
      repositories.map((repository) => file(join(repository, "seed.txt"))),
    );

    expect(Object.keys(snapshot.repositories)).toHaveLength(10);
  });

  it("still reads git for a path the snapshot never saw", () => {
    const snapshot = snapshotRepositories(alpha);

    expect(
      createRepositoryAttributor({ ...options, snapshot }).toolMetadata(
        base,
        file(betaSeed, alpha),
      ),
    ).toEqual({ ...base, ...everythingBetaReveals });
  });
});
