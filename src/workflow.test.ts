import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { defineBinaryTarget } from "./binary.js";
import { APPLE_CREDENTIALS } from "./constants.js";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: { name?: string; pattern?: string; ref?: string; repository?: string; path?: string };
}

interface Job {
  steps?: Step[];
  strategy?: { matrix?: { include?: { arch: string; runner: string }[] } };
  needs?: string[];
  if?: string;
  env?: Record<string, string>;
  environment?: string;
  concurrency?: { group: string; "cancel-in-progress": boolean };
}

const WORKFLOW = parse(
  readFileSync(new URL("../.github/workflows/build-binary.yml", import.meta.url), "utf-8"),
) as {
  on: Record<string, { inputs?: Record<string, unknown> }>;
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, Job>;
};

const PUBLISHING_GATE = "needs.plan.outputs.publishing == 'true'";
const OUR_TEAM = "H253X88X9F";
const BUNDLE_STEP = "Bundle Both Chips Into One Compressed Binary";
const BUNDLED_BYTES = "signed universal bytes";
const DOWNLOADED_MODE = 0o644;
const SIBLING_FILE = "other-pipeline-binary";
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const BINARY_TEST = "${{ inputs.binary-test }}";
const TAG_TEST = /startsWith\(\s*github\.ref\s*,\s*'([^']*)'\s*\)/;
const APPLE_SECRET = /secrets\.(?:APPLE|CSC)_/;
const MANIFEST = ".claude-plugin/plugin.json";
const BUNDLE = "bundle/dispatch.js";
const INSTALL_STEP = "Install Dependencies";
const INSTALLED_ENGINE = "node_modules/@langchain/plugins-base";
const CONFIG_STEP = "Read the Binary Config";
const VERSION_STEP = "Check the Version Matches the Tag";
const BETA_STEP = "Find the Branch This Tag Belongs To";
const SIGN_STEP = "Sign and Notarize the Binary";
const PROPOSE_STEP = "Land the Binaries on the Branch This Tag Belongs To";
const GATE_STEP = "Decide Whether This Run Is Releasing";
const PIPELINE_ROOT = new URL("../", import.meta.url).pathname;
const SIGNED_PATTERN = "${{ needs.plan.outputs.executable }}-darwin-*-signed";
const BETA_BRANCH = "beta-1.2.0";
const RELEASED_TAG = "1.2.0-beta.4";
const STABLE_TAG = "0.5.0";
const DEFAULT_BRANCH = "main";
const BUMP_BRANCH = "ejaimez/bump-0-5-0";
const TAGGED_COMMIT = "c0ffee1c0ffee2c0ffee3c0ffee4c0ffee5c0ffe";
const BRANCH_IS_MISSING = "gh: Branch not found (HTTP 404)";
const REPOSITORY_IS_MISSING = "gh: Not Found (HTTP 404)";
const CREDENTIALS_FAILED = "gh: Bad credentials (HTTP 401)";
const GITHUB_IS_DOWN = "gh: HTTP 502";
const UNAVAILABLE = "unavailable";
const WORDLESS = "wordless";
const EXECUTABLE = "langsmith-codex-tracing";
const CARRIED_DIRECTORY = "binary";
const SIGNED_BYTES: Readonly<Record<string, string>> = {
  arm64: "signed arm64 bytes",
  x64: "signed x64 bytes",
};
const ISOLATED_GIT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function scratch(prefix = "plugin-binary-workflow-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fixtureCopy(consumer: string, at = "."): string {
  const root = scratch();
  cpSync(new URL(`../test/fixtures/${consumer}/`, import.meta.url).pathname, join(root, at), {
    recursive: true,
  });
  return root;
}

function stepNamed(job: string, step: string): Step {
  const found = WORKFLOW.jobs[job]?.steps?.find((candidate) => candidate.name === step);
  if (found === undefined) throw new Error(`the workflow has no ${job} step named ${step}`);
  return found;
}

function script(job: string, step: string): string {
  return stepNamed(job, step).run ?? "";
}

function handedOver(job: string, action: string): string[] {
  return (WORKFLOW.jobs[job]?.steps ?? [])
    .filter((step) => step.uses?.startsWith(`actions/${action}-artifact@`) === true)
    .map((step) => step.with?.name ?? "");
}

function binaryTests(job: string): Step[] {
  return (WORKFLOW.jobs[job]?.steps ?? []).filter((step) => step.env?.BINARY_TEST !== undefined);
}

function jobsWhere(holds: (job: Job, name: string) => boolean): string[] {
  return Object.keys(WORKFLOW.jobs).filter((name) => holds(WORKFLOW.jobs[name] ?? {}, name));
}

function ancestors(name: string): string[] {
  const needs = [WORKFLOW.jobs[name]?.needs ?? []].flat();
  return [...new Set(needs.flatMap((need) => [need, ...ancestors(need)]))];
}

function tagPrefix(expression: string): string {
  const found = TAG_TEST.exec(expression);
  if (found === null) throw new Error(`${expression} never tests github.ref against a tag`);
  return found[1] ?? "";
}

function runStep(
  job: string,
  step: string,
  cwd: string,
  env: Record<string, string> = {},
): Record<string, string> {
  const installed = join(cwd, INSTALLED_ENGINE);
  if (!existsSync(installed)) {
    mkdirSync(dirname(installed), { recursive: true });
    symlinkSync(PIPELINE_ROOT, installed, "dir");
  }
  const outputFile = join(scratch(), "output");
  writeFileSync(outputFile, "");
  execFileSync("/bin/bash", ["-e", "-c", script(job, step)], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      CONFIG: "binary.config.json",
      GITHUB_OUTPUT: outputFile,
      ...env,
    },
  });
  return Object.fromEntries(
    readFileSync(outputFile, "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split(/=(.*)/s) as [string, string]),
  );
}

describe("reading the plugin's config", () => {
  it("runs the checks from the engine the plugin installed, after installing it", () => {
    const steps = (WORKFLOW.jobs.plan?.steps ?? []).map(({ name }) => name);
    expect(script("plan", INSTALL_STEP)).toBe("pnpm install --frozen-lockfile");
    expect(steps.indexOf(INSTALL_STEP)).toBeLessThan(steps.indexOf(CONFIG_STEP));
    expect(script("plan", CONFIG_STEP)).toContain(INSTALLED_ENGINE);
  });

  it("finds where the build leaves each binary, however deep the plugin keeps them", () => {
    expect(runStep("plan", CONFIG_STEP, fixtureCopy("codex"))).toEqual({
      executable: "langsmith-codex-tracing",
      "output-directory": "plugins/tracing/bin",
      "host-binary": "plugins/tracing/bin/langsmith-codex-tracing",
      "cross-binary": "plugins/tracing/bin/darwin-x64/langsmith-codex-tracing",
    });
  });

  it("reads those paths from the config's own folder, not the repository root", () => {
    const root = fixtureCopy("claude-code", "tools");
    expect(runStep("plan", CONFIG_STEP, root, { CONFIG: "tools/binary.config.json" })).toEqual({
      executable: "langsmith-claude-code-tracing",
      "output-directory": "tools/bin",
      "host-binary": "tools/bin/langsmith-claude-code-tracing",
      "cross-binary": "tools/bin/darwin-x64/langsmith-claude-code-tracing",
    });
  });

  it("builds and signs from the config the plan read", () => {
    for (const [job, step] of [
      ["plan", CONFIG_STEP],
      ["build", "Build the Unsigned Binaries"],
      ["sign", SIGN_STEP],
    ] as const) {
      expect(stepNamed(job, step).env?.CONFIG).toBe("${{ inputs.config }}");
    }
    expect(script("build", "Build the Unsigned Binaries")).toContain('--config "$CONFIG"');
    expect(script("sign", SIGN_STEP)).toContain('--config "$CONFIG"');
  });

  it("stops when a plugin asks for a chip this pipeline cannot build", () => {
    const root = fixtureCopy("codex");
    const config = JSON.parse(readFileSync(join(root, "binary.config.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    config.publishedTargets = { linux: ["x64"] };
    writeFileSync(join(root, "binary.config.json"), JSON.stringify(config));
    expect(() => runStep("plan", CONFIG_STEP, root)).toThrow();
  });
});

describe("checking the tag against the version", () => {
  it("reads the tag and the plugin's config, and takes no file list of its own", () => {
    expect(stepNamed("plan", VERSION_STEP).env).toEqual({
      CONFIG: "${{ inputs.config }}",
      TAG: "${{ github.ref_name }}",
    });
  });

  it("lets a tag through for a plugin that names one version file", () => {
    expect(() =>
      runStep("plan", VERSION_STEP, fixtureCopy("codex"), { TAG: "0.2.0-beta" }),
    ).not.toThrow();
  });

  it("lets a tag through for a plugin whose every named file advertises it", () => {
    expect(() =>
      runStep("plan", VERSION_STEP, fixtureCopy("claude-code"), { TAG: "0.3.1" }),
    ).not.toThrow();
  });

  it("stops a tag the version file the binary is built from does not match", () => {
    const root = fixtureCopy("claude-code");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.3.0" }));
    expect(() => runStep("plan", VERSION_STEP, root, { TAG: "0.3.1" })).toThrow(
      "package.json is 0.3.0 but the tag is 0.3.1. Bump the version, then retag.",
    );
  });

  it("stops a release where another file the plugin names advertises a different version", () => {
    const root = fixtureCopy("claude-code", "tools");
    writeFileSync(join(root, "tools", MANIFEST), JSON.stringify({ version: "0.3.0" }));
    expect(() =>
      runStep("plan", VERSION_STEP, root, { CONFIG: "tools/binary.config.json", TAG: "0.3.1" }),
    ).toThrow(`tools/${MANIFEST} is 0.3.0 but the tag is 0.3.1. Bump the version, then retag.`);
  });

  it("stops a tag whose built bundle still carries an older version", () => {
    const root = fixtureCopy("claude-code");
    writeFileSync(join(root, BUNDLE), 'var version = "0.3.0";\n');
    expect(() => runStep("plan", VERSION_STEP, root, { TAG: "0.3.1" })).toThrow(
      `${BUNDLE} was not built at 0.3.1. Rebuild it, commit it, then retag.`,
    );
  });

  it("stops a tag the built bundle only begins with, so a beta build cannot pass as the release", () => {
    const root = fixtureCopy("claude-code");
    writeFileSync(join(root, BUNDLE), 'var version = "0.3.1-beta.1";\n');
    expect(() => runStep("plan", VERSION_STEP, root, { TAG: "0.3.1" })).toThrow(
      `${BUNDLE} was not built at 0.3.1.`,
    );
  });

  it("stops a plugin naming a file outside its own repository", () => {
    const root = fixtureCopy("claude-code");
    const config = JSON.parse(readFileSync(join(root, "binary.config.json"), "utf-8")) as {
      build: Record<string, unknown>;
    };
    config.build.matchingVersionFiles = ["../elsewhere/package.json"];
    writeFileSync(join(root, "binary.config.json"), JSON.stringify(config));
    expect(() => runStep("plan", VERSION_STEP, root, { TAG: "0.3.1" })).toThrow(
      "build.matchingVersionFiles must be an array of paths inside the repository",
    );
  });
});

function findTheBetaBranch(
  answers: { lookup?: string; comparison?: string } = {},
  tag = RELEASED_TAG,
): Record<string, string> {
  const path = scratch("plugin-binary-beta-");
  writeFileSync(
    join(path, "gh"),
    [
      "#!/bin/sh",
      'case "$2" in',
      `  */branches/*) [ -z "$LOOKUP" ] || { [ "$LOOKUP" = ${WORDLESS} ] || echo "$LOOKUP" >&2; exit 1; } ;;`,
      `  */compare/*) [ "$COMPARISON" != ${UNAVAILABLE} ] || { echo "${GITHUB_IS_DOWN}" >&2; exit 1; }`,
      '    echo "$COMPARISON" ;;',
      "  *) echo main ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(path, "gh"), 0o755);
  return runStep("plan", BETA_STEP, path, {
    PATH: `${path}:${process.env.PATH ?? ""}`,
    GH_TOKEN: "unused by the stub",
    GH_REPO: "langchain-ai/example-plugins",
    TAG: tag,
    LOOKUP: answers.lookup ?? "",
    COMPARISON: answers.comparison ?? "ahead",
  });
}

const comparisonUnavailable = (): Record<string, string> =>
  findTheBetaBranch({ comparison: UNAVAILABLE });

function findTheStableBranch(heads: string[], tag = STABLE_TAG): Record<string, string> {
  const path = scratch("plugin-binary-stable-");
  writeFileSync(
    join(path, "gh"),
    [
      "#!/bin/sh",
      'case "$2" in',
      '  */branches-where-head) [ -z "$HEADS" ] || printf \'%s\\n\' "$HEADS" ;;',
      '  */commits/*) echo "$COMMIT_SHA" ;;',
      '  *) echo "$DEFAULT" ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(path, "gh"), 0o755);
  return runStep("plan", BETA_STEP, path, {
    PATH: `${path}:${process.env.PATH ?? ""}`,
    GH_TOKEN: "unused by the stub",
    GH_REPO: "langchain-ai/example-plugins",
    TAG: tag,
    PRERELEASE: "false",
    HEADS: heads.join("\n"),
    DEFAULT: DEFAULT_BRANCH,
    COMMIT_SHA: TAGGED_COMMIT,
  });
}

describe("finding the branch a tag belongs to", () => {
  it("sends a stable release to the branch the tag sits at the tip of", () => {
    expect(findTheStableBranch([BUMP_BRANCH])).toEqual({
      branch: BUMP_BRANCH,
      "commit-directly": "true",
    });
  });

  it("keeps the separate pull request when somebody tags the default branch itself", () => {
    expect(findTheStableBranch([DEFAULT_BRANCH])).toEqual({
      branch: DEFAULT_BRANCH,
      "commit-directly": "false",
    });
  });

  it("stops a stable tag that sits at the tip of no branch at all", () => {
    expect(() => findTheStableBranch([])).toThrow(
      `${STABLE_TAG} is not at the tip of any branch, so these binaries have nowhere to land.`,
    );
  });

  it("stops a stable tag that two branches both end at, rather than guessing between them", () => {
    expect(() => findTheStableBranch([BUMP_BRANCH, "someone-else/bump"])).toThrow(
      `${STABLE_TAG} is at the tip of more than one branch: ${BUMP_BRANCH} someone-else/bump`,
    );
  });

  it("settles on the default branch when it is one of the branches ending at the tag", () => {
    expect(findTheStableBranch([BUMP_BRANCH, DEFAULT_BRANCH])).toEqual({
      branch: DEFAULT_BRANCH,
      "commit-directly": "false",
    });
  });

  it("works out the branch from the tag, so nobody has to name it", () => {
    expect(findTheBetaBranch()).toEqual({ branch: BETA_BRANCH, "commit-directly": "false" });
  });

  it("stops a beta with no branch waiting for it", () => {
    expect(() => findTheBetaBranch({ lookup: BRANCH_IS_MISSING })).toThrow(
      `${RELEASED_TAG} belongs to ${BETA_BRANCH}, which does not exist.`,
    );
  });

  it("stops a beta branch that is behind the work already on the default branch", () => {
    expect(() => findTheBetaBranch({ comparison: "behind" })).toThrow(
      `${BETA_BRANCH} is missing work that is already on main`,
    );
  });

  it("repeats what GitHub said when the branch lookup fails for some other reason", () => {
    const refused = (): Record<string, string> => findTheBetaBranch({ lookup: CREDENTIALS_FAILED });
    expect(refused).toThrow(CREDENTIALS_FAILED);
    expect(refused).not.toThrow(`belongs to ${BETA_BRANCH}, which does not exist`);
  });

  it("blames no branch when the repository itself is the thing GitHub cannot find", () => {
    expect(() => findTheBetaBranch({ lookup: REPOSITORY_IS_MISSING })).toThrow(
      REPOSITORY_IS_MISSING,
    );
  });

  it("still says something when the lookup fails and GitHub says nothing at all", () => {
    expect(() => findTheBetaBranch({ lookup: WORDLESS })).toThrow(
      `Looking ${BETA_BRANCH} up failed and GitHub said nothing`,
    );
  });

  it("repeats what GitHub said when it cannot say how the two branches compare", () => {
    expect(comparisonUnavailable).toThrow(GITHUB_IS_DOWN);
    expect(comparisonUnavailable).not.toThrow(`${BETA_BRANCH} is missing work`);
  });
});

describe("the names the pipeline publishes under", () => {
  const publish = script("publish", "Attach the Binaries to the Release");

  it("uploads exactly the file the install script and the updater download", () => {
    const codex = defineBinaryTarget({
      executableName: EXECUTABLE,
      repository: "langchain-ai/langsmith-codex-plugins",
      userAgent: "langsmith-codex",
      releasesApiOverrideEnvVar: "LANGSMITH_CODEX_RELEASES_API",
    });
    const naming = publish
      .split("\n")
      .find((line) => line.includes('NAME="$EXECUTABLE-darwin-$ARCH'));
    const named = execFileSync("/bin/bash", ["-c", `${naming}; printf '%s' "$NAME"`], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", EXECUTABLE, ARCH: "arm64", TAG: "0.6.0" },
    });
    expect(named).toBe(codex.assetName("darwin", "arm64", "0.6.0"));
  });

  it("publishes a checksum beside every binary", () => {
    expect(publish).toContain('sha256sum "$NAME" > "$NAME.sha256"');
  });

  it("refuses to publish when a signing job produced nothing", () => {
    expect(publish).toContain("Nothing is published.");
  });

  it("lets only a bundle pipeline skip the queue, so pipelines that don't bundle still take turns", () => {
    expect(WORKFLOW.concurrency.group).toBe(
      "${{ github.workflow }}-${{ github.ref }}${{ inputs.bundle && format('-{0}', inputs.config) || '' }}",
    );
  });
});

describe("keeping the signed and unsigned binaries apart", () => {
  it("uploads the unsigned builds under their own names", () => {
    expect(handedOver("build", "upload")).toEqual([
      "${{ needs.plan.outputs.executable }}-darwin-arm64-unsigned",
      "${{ needs.plan.outputs.executable }}-darwin-x64-unsigned",
    ]);
  });

  it("uploads the signed build under a name nothing else uses", () => {
    expect(handedOver("sign", "upload")).toEqual([
      "${{ needs.plan.outputs.executable }}-darwin-${{ matrix.arch }}-signed",
    ]);
    expect(handedOver("sign", "download")).toEqual([
      "${{ needs.plan.outputs.executable }}-darwin-${{ matrix.arch }}-unsigned",
    ]);
  });

  it("publishes nothing that has not been through signing", () => {
    expect(stepNamed("publish", "Download the Signed Binaries").with?.pattern).toBe(SIGNED_PATTERN);
  });

  it("never lets a signing run turn itself off", () => {
    expect(stepNamed("sign", SIGN_STEP).if).toBeUndefined();
  });

  it("only publishes once the Intel run, both signings and any bundle have passed", () => {
    expect(WORKFLOW.jobs.publish?.needs).toEqual([
      "plan",
      "build",
      "run-on-intel",
      "sign",
      "bundle",
    ]);
    const gate = WORKFLOW.jobs.publish?.if ?? "";
    for (const job of ["build", "run-on-intel", "sign"]) {
      expect(gate).toContain(`needs.${job}.result == 'success'`);
    }
    expect(gate).toContain("(!inputs.bundle || needs.bundle.result == 'success')");
  });

  it("signs on a machine matching each chip", () => {
    expect(WORKFLOW.jobs.sign?.strategy?.matrix?.include).toEqual([
      { arch: "arm64", runner: "macos-26" },
      { arch: "x64", runner: "macos-26-intel" },
    ]);
  });
});

describe("keeping the Apple credentials inside the signing environment", () => {
  it("never reads an Apple credential outside a job that entered the environment", () => {
    expect(jobsWhere((job) => APPLE_SECRET.test(JSON.stringify(job)))).toEqual(
      jobsWhere((job) => job.environment !== undefined),
    );
  });

  it("never enters the signing environment on a run that is not publishing", () => {
    expect(
      jobsWhere(
        (job) =>
          job.environment !== undefined &&
          (job.if ?? "").replace(/\s+/g, " ").trim() === PUBLISHING_GATE,
      ),
    ).toEqual(jobsWhere((job) => job.environment !== undefined));
  });

  it("wires every credential the signing script asks for into the signing step", () => {
    expect(stepNamed("sign", SIGN_STEP).env).toMatchObject(
      Object.fromEntries(APPLE_CREDENTIALS.map((name) => [name, `\${{ secrets.${name} }}`])),
    );
  });
});

describe("the release path no pull request ever runs", () => {
  it("agrees on what a tag looks like everywhere it decides that", () => {
    expect(tagPrefix(WORKFLOW.concurrency["cancel-in-progress"])).toBe(
      tagPrefix(stepNamed("plan", GATE_STEP).env?.PUBLISHING ?? ""),
    );
  });

  it("restores the executable bit in every job that runs a binary it downloaded", () => {
    const downloadsAndRuns = jobsWhere(
      (_job, name) => handedOver(name, "download").length > 0 && binaryTests(name).length > 0,
    );
    const restoresTheBit = jobsWhere((job) =>
      (job.steps ?? []).some(
        (step) => step.run?.includes("chmod +x") === true && step.if === undefined,
      ),
    );
    expect(downloadsAndRuns.filter((name) => !restoresTheBit.includes(name))).toEqual([]);
  });

  it("puts the signed binary through the same test the unsigned one passed", () => {
    expect(binaryTests("sign").map((step) => [step.env, step.run])).toEqual(
      binaryTests("build").map((step) => [step.env, step.run]),
    );
  });

  it("tests every build with the script the plugin names, so a second binary skips the first one's test", () => {
    const inputs = WORKFLOW.on.workflow_call?.inputs ?? {};
    expect(inputs["binary-test"]).toEqual(expect.objectContaining({ default: "test:binary" }));
    const testing = ["build", "run-on-intel", "sign"].flatMap(binaryTests);
    expect(testing).toHaveLength(3);
    for (const step of testing) {
      expect(step.env?.BINARY_TEST).toBe(BINARY_TEST);
      expect(step.run?.trim()).toBe('pnpm "$BINARY_TEST"');
    }
    expect(JSON.stringify(WORKFLOW.jobs)).not.toContain("pnpm test:binary");
  });

  it("keeps the trigger the plugin repositories release through", () => {
    expect(Object.keys(WORKFLOW.on)).toContain("workflow_call");
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    env: { PATH: process.env.PATH ?? "", ...ISOLATED_GIT },
  });
}

function fakeTool(work: string, name: string, lines: string[]): string {
  const tools = join(work, "tools");
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, name), ["#!/bin/sh", ...lines, "exit 0", ""].join("\n"));
  chmodSync(join(tools, name), 0o755);
  return tools;
}

function buildBothChips({ signIntel = true, exitCode = 0, stage = "unsigned" } = {}): string {
  const work = scratch("plugin-binary-bundle-");
  const source = join(work, "version.c");
  writeFileSync(
    source,
    `#include <stdio.h>\nint main(void) { puts("1.2.3"); return ${exitCode}; }\n`,
  );
  for (const [arch, clangArch] of [
    ["arm64", "arm64"],
    ["x64", "x86_64"],
  ] as const) {
    const built = join(work, "built", `${EXECUTABLE}-darwin-${arch}-${stage}`, EXECUTABLE);
    mkdirSync(dirname(built), { recursive: true });
    execFileSync("/usr/bin/clang", ["-arch", clangArch, source, "-o", built]);
    if (arch === "arm64" || signIntel) {
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", built]);
    }
    chmodSync(built, DOWNLOADED_MODE);
  }
  return work;
}

function proposeTheBinaries({
  directory = CARRIED_DIRECTORY,
  directly = false,
  bundle = false,
  siblingLandedFirst = false,
  leftovers = [] as string[],
} = {}): { origin: string; body: string; log: string } {
  const root = scratch("plugin-binary-propose-");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const path = join(root, "path");

  git(root, "init", "--bare", `--initial-branch=${BETA_BRANCH}`, origin);
  git(root, "clone", origin, work);
  mkdirSync(join(work, CARRIED_DIRECTORY), { recursive: true });
  writeFileSync(join(work, CARRIED_DIRECTORY, ".gitkeep"), "");
  for (const leftover of leftovers) writeFileSync(join(work, CARRIED_DIRECTORY, leftover), "old");
  git(work, "add", "-A");
  git(work, "-c", "user.name=Seed", "-c", "user.email=s@example.invalid", "commit", "-m", "Seed");
  git(work, "push", "origin", `HEAD:refs/heads/${BETA_BRANCH}`);
  if (siblingLandedFirst) {
    const sibling = join(root, "sibling");
    git(root, "clone", origin, sibling);
    writeFileSync(join(sibling, CARRIED_DIRECTORY, SIBLING_FILE), "the other pipeline's binary");
    git(sibling, "add", "-A");
    git(
      sibling,
      "-c",
      "user.name=Sibling",
      "-c",
      "user.email=b@example.invalid",
      "commit",
      "-m",
      "Sibling",
    );
    git(sibling, "push", "origin", `HEAD:refs/heads/${BETA_BRANCH}`);
  }

  for (const [arch, bytes] of Object.entries(SIGNED_BYTES)) {
    const uploaded = join(work, "signed", `${EXECUTABLE}-darwin-${arch}-signed`);
    mkdirSync(uploaded, { recursive: true });
    writeFileSync(join(uploaded, EXECUTABLE), bytes);
  }
  writeFileSync(join(work, "signed", `${EXECUTABLE}.tar.xz`), BUNDLED_BYTES);
  mkdirSync(path);
  writeFileSync(
    join(path, "gh"),
    [
      "#!/bin/sh",
      'echo "$1 $2" >> "$GH_LOG"',
      'case "$1 $2" in',
      "  'release view') echo 'https://example.invalid/releases/tag' ;;",
      "  'pr view') exit 1 ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(path, "gh"), 0o755);
  const log = join(root, "gh-calls.txt");
  writeFileSync(log, "");

  execFileSync("/bin/bash", ["-e", "-c", script("propose", PROPOSE_STEP)], {
    cwd: work,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      PATH: `${path}:${process.env.PATH ?? ""}`,
      ...ISOLATED_GIT,
      GH_TOKEN: "unused by the stub",
      GH_LOG: log,
      GH_REPO: "langchain-ai/example-plugins",
      BASE: BETA_BRANCH,
      DIRECTLY: String(directly),
      BUNDLE: String(bundle),
      DIRECTORY: directory,
      EXECUTABLE,
      TAG: RELEASED_TAG,
      RUNNER_TEMP: root,
    },
  });

  const bodyPath = join(root, "pull-request-body.md");
  return {
    origin,
    body: existsSync(bodyPath) ? readFileSync(bodyPath, "utf-8") : "",
    log: readFileSync(log, "utf-8"),
  };
}

describe("offering the binaries to the plugin's beta branch", () => {
  const branch = `binary/${RELEASED_TAG}`;

  it("pushes both binaries still runnable, so a clone can execute what gets merged", () => {
    const { origin } = proposeTheBinaries();
    for (const [arch, bytes] of Object.entries(SIGNED_BYTES)) {
      const carried = `${CARRIED_DIRECTORY}/${EXECUTABLE}-darwin-${arch}`;
      expect(git(origin, "ls-tree", branch, carried)).toMatch(/^100755 blob/);
      expect(git(origin, "show", `${branch}:${carried}`)).toBe(bytes);
    }
    expect(git(origin, "log", "-1", "--format=%s", branch).trim()).toBe(
      `chore(binary): Add the Signed Binaries for ${RELEASED_TAG}`,
    );
  });

  it("stops when the folder named is not the one the plugin runs its builds from", () => {
    expect(() => proposeTheBinaries({ directory: "somewhere/else" })).toThrow(
      /has no somewhere\/else folder\. Point binary-directory at the folder/,
    );
  });

  it("aims at whichever branch the tag belongs to, never at one the job picks itself", () => {
    expect(stepNamed("propose", "Check Out the Branch the Binaries Belong On").with?.ref).toBe(
      "${{ needs.plan.outputs.target-branch }}",
    );
    expect(stepNamed("propose", PROPOSE_STEP).env?.BASE).toBe(
      "${{ needs.plan.outputs.target-branch }}",
    );
    expect(JSON.stringify(WORKFLOW.jobs.propose)).not.toContain("default_branch");
  });

  it("commits onto the branch the tag came from, so one merge ships the version and the builds", () => {
    const { origin, log } = proposeTheBinaries({ directly: true });
    for (const [arch, bytes] of Object.entries(SIGNED_BYTES)) {
      const carried = `${CARRIED_DIRECTORY}/${EXECUTABLE}-darwin-${arch}`;
      expect(git(origin, "ls-tree", BETA_BRANCH, carried)).toMatch(/^100755 blob/);
      expect(git(origin, "show", `${BETA_BRANCH}:${carried}`)).toBe(bytes);
    }
    expect(git(origin, "branch", "--list", branch).trim()).toBe("");
    expect(log).not.toContain("pr create");
  });

  it("lands beside a sibling pipeline that committed to the same branch first", () => {
    const { origin } = proposeTheBinaries({ directly: true, siblingLandedFirst: true });
    const landed = git(origin, "ls-tree", "--name-only", BETA_BRANCH, `${CARRIED_DIRECTORY}/`);
    expect(landed).toContain(`${CARRIED_DIRECTORY}/${SIBLING_FILE}`);
    expect(landed).toContain(`${CARRIED_DIRECTORY}/${EXECUTABLE}-darwin-arm64`);
  });

  it("drops the other layout's binaries when a plugin switches between a bundle and one per chip", () => {
    const perChip = [`${EXECUTABLE}-darwin-arm64`, `${EXECUTABLE}-darwin-x64`];
    const bundled = `${EXECUTABLE}.tar.xz`;
    const landed = (bundle: boolean, leftovers: string[]) =>
      git(
        proposeTheBinaries({ directly: true, bundle, leftovers }).origin,
        "ls-tree",
        "--name-only",
        BETA_BRANCH,
        `${CARRIED_DIRECTORY}/`,
      )
        .trim()
        .split("\n");
    expect(landed(true, perChip)).toEqual([
      `${CARRIED_DIRECTORY}/.gitkeep`,
      `${CARRIED_DIRECTORY}/${bundled}`,
    ]);
    expect(landed(false, [bundled])).toEqual([
      `${CARRIED_DIRECTORY}/.gitkeep`,
      ...perChip.map((name) => `${CARRIED_DIRECTORY}/${name}`),
    ]);
  });

  it("takes the choice between the two from the plan, not from a guess of its own", () => {
    expect(stepNamed("propose", PROPOSE_STEP).env?.DIRECTLY).toBe(
      "${{ needs.plan.outputs.commit-directly }}",
    );
  });

  it("offers the binaries on a stable release too, so a stable user is not left without one", () => {
    expect(WORKFLOW.jobs.propose?.if).not.toContain("prerelease");
  });

  it("lets no caller name a branch of its own", () => {
    expect(Object.keys(WORKFLOW.on.workflow_call?.inputs ?? {})).not.toContain("beta-branch");
  });

  it("names the tag and checksums the bytes, so a swapped binary cannot pass as the signed one", () => {
    const { body } = proposeTheBinaries();
    expect(body).toContain(`Built from tag ${RELEASED_TAG}`);
    expect(body).toContain("Replaces the pair the previous beta left behind");
    expect(body).toContain("then attached to https://example.invalid/releases/tag");
    for (const [arch, bytes] of Object.entries(SIGNED_BYTES)) {
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(body).toContain(
        `- [x] ${arch} is ${Buffer.byteLength(bytes)} bytes, sha256 ${digest}`,
      );
    }
  });

  it("calls a dashed tag a beta and a plain one a full release", () => {
    const beta = runStep("plan", GATE_STEP, fixtureCopy("claude-code"), { TAG: "0.4.0-beta.2" });
    const full = runStep("plan", GATE_STEP, fixtureCopy("claude-code"), { TAG: "0.4.0" });
    expect([beta.prerelease, full.prerelease]).toEqual(["true", "false"]);
  });

  it("offers nothing unless the run is releasing", () => {
    const gate = (WORKFLOW.jobs.propose?.if ?? "").replace(/\s+/g, " ");
    expect(gate).toContain(PUBLISHING_GATE);
  });

  it("works the branch out on exactly the runs that offer it, so nothing lands on the default branch", () => {
    expect(stepNamed("plan", BETA_STEP).if).toBe(
      PUBLISHING_GATE.replaceAll("needs.plan.outputs", "steps.gate.outputs"),
    );
  });

  it("offers nothing that has not been through signing", () => {
    expect(stepNamed("propose", "Download the Signed Binaries").with?.pattern).toBe(SIGNED_PATTERN);
  });

  it("waits for the release, so a repository it cannot write to costs nobody the release", () => {
    expect(WORKFLOW.jobs.propose?.needs).toContain("publish");
    expect(WORKFLOW.jobs.propose?.if).toContain("needs.publish.result == 'success'");
  });

  it("runs every job below one that can be skipped, since GitHub otherwise skips the whole chain", () => {
    const skippable = jobsWhere((job) => job.if !== undefined);
    expect(
      jobsWhere(
        (job, name) =>
          ancestors(name).some((ancestor) => skippable.includes(ancestor)) &&
          !(job.if ?? "").includes("!cancelled()"),
      ),
    ).toEqual([]);
  });

  it("lands the bundle on a branch of its own, so a second pipeline on the same tag keeps its binaries", () => {
    const { origin, body } = proposeTheBinaries({ bundle: true });
    const bundleBranch = `binary/${RELEASED_TAG}-bundled`;
    const carried = `${CARRIED_DIRECTORY}/${EXECUTABLE}.tar.xz`;
    expect(git(origin, "show", `${bundleBranch}:${carried}`)).toBe(BUNDLED_BYTES);
    expect(
      git(origin, "ls-tree", "--name-only", bundleBranch, `${CARRIED_DIRECTORY}/`)
        .trim()
        .split("\n"),
    ).toEqual([`${CARRIED_DIRECTORY}/.gitkeep`, carried]);
    expect(git(origin, "branch", "--list", branch).trim()).toBe("");
    const digest = createHash("sha256").update(BUNDLED_BYTES).digest("hex");
    expect(body).toContain(
      `- [x] both chips are ${Buffer.byteLength(BUNDLED_BYTES)} bytes compressed, sha256 ${digest}`,
    );
    expect(body).toContain("Replaces the bundle the previous beta left behind");
    expect(body).toContain("then attached to https://example.invalid/releases/tag");
  });

  it("lands only a bundle built from signed binaries, and only once it exists", () => {
    expect(stepNamed("propose", "Download the Bundled Binary").with?.name).toBe(
      "${{ needs.plan.outputs.executable }}-darwin-universal-signed",
    );
    expect(stepNamed("publish", "Download the Bundled Binary").with?.name).toBe(
      "${{ needs.plan.outputs.executable }}-darwin-universal-signed",
    );
    expect(WORKFLOW.jobs.bundle?.env?.STAGE).toBe(
      "${{ needs.plan.outputs.publishing == 'true' && 'signed' || 'unsigned' }}",
    );
  });

  it.runIf(process.platform === "darwin")(
    "bundles both chips into one compressed file that still runs once unpacked",
    () => {
      const work = buildBothChips();
      runStep("bundle", BUNDLE_STEP, work, { EXECUTABLE, STAGE: "unsigned" });
      const bundled = join(work, "bundled", `${EXECUTABLE}.tar.xz`);
      expect(readFileSync(bundled).subarray(0, XZ_MAGIC.length)).toEqual(XZ_MAGIC);
      const unpacked = join(scratch(), "unpacked");
      mkdirSync(unpacked);
      execFileSync("/usr/bin/tar", ["-xJf", bundled, "-C", unpacked]);
      const binary = join(unpacked, EXECUTABLE);
      expect(
        execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf-8" })
          .trim()
          .split(" ")
          .toSorted(),
      ).toEqual(["arm64", "x86_64"]);
      expect(execFileSync(binary, { encoding: "utf-8" }).trim()).toBe("1.2.3");
    },
    20_000,
  );

  it.runIf(process.platform === "darwin")("refuses to bundle a chip nothing signed", () => {
    const work = buildBothChips({ signIntel: false });
    expect(() => runStep("bundle", BUNDLE_STEP, work, { EXECUTABLE, STAGE: "unsigned" })).toThrow();
  });

  it.runIf(process.platform === "darwin")(
    "refuses a bundle that will not run once unpacked",
    () => {
      const work = buildBothChips({ exitCode: 1 });
      expect(() =>
        runStep("bundle", BUNDLE_STEP, work, { EXECUTABLE, STAGE: "unsigned" }),
      ).toThrow();
    },
  );

  it("bundles a release only from builds that finished signing and ran on Intel", () => {
    const gate = WORKFLOW.jobs.bundle?.if ?? "";
    expect(gate).toContain(
      "(needs.sign.result == 'success' || needs.plan.outputs.publishing != 'true')",
    );
    expect(gate).toContain("needs.run-on-intel.result == 'success'");
  });

  it.runIf(process.platform === "darwin")(
    "refuses to bundle a release anyone but our Apple team signed, since the plugin would refuse it",
    () => {
      const work = buildBothChips({ stage: "signed" });
      expect(() => runStep("bundle", BUNDLE_STEP, work, { EXECUTABLE, STAGE: "signed" })).toThrow(
        new RegExp(`signed by team not set, not ${OUR_TEAM}`),
      );
      const signedBy = (team: string) => {
        const tools = fakeTool(work, "codesign", [
          `case "$1" in -dv) echo "TeamIdentifier=${team}" >&2 ;; esac`,
        ]);
        return () =>
          runStep("bundle", BUNDLE_STEP, work, {
            EXECUTABLE,
            STAGE: "signed",
            PATH: `${tools}:${process.env.PATH ?? ""}`,
          });
      };
      expect(signedBy("ZZZZ999999")).toThrow(
        new RegExp(`signed by team ZZZZ999999, not ${OUR_TEAM}`),
      );
      expect(signedBy(OUR_TEAM)).not.toThrow();
    },
  );

  it("downloads a bundle only for plugins that bundle, so every other plugin still lands its binaries", () => {
    expect(stepNamed("propose", "Download the Bundled Binary").if).toBe("inputs.bundle");
  });

  it("attaches the bundle to the release with a checksum beside it", () => {
    const work = scratch("plugin-binary-publish-");
    mkdirSync(join(work, "signed"));
    writeFileSync(join(work, "signed", `${EXECUTABLE}.tar.xz`), BUNDLED_BYTES);
    const tools = fakeTool(work, "gh", [
      'echo "$@" >> "$GH_LOG"',
      '[ "$1 $2" = "release view" ] && exit 1',
    ]);
    const log = join(work, "gh-calls.txt");
    runStep("publish", "Attach the Binaries to the Release", work, {
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      GH_LOG: log,
      EXECUTABLE,
      TAG: RELEASED_TAG,
      PRERELEASE: "true",
      EXTRA_NOTES: "",
      BUNDLE: "true",
    });
    const asset = `${EXECUTABLE}-darwin-universal-${RELEASED_TAG}.tar.xz`;
    expect(readFileSync(log, "utf-8")).toContain(
      `release create ${RELEASED_TAG} release/${asset} release/${asset}.sha256`,
    );
    expect(readFileSync(join(work, "release", asset), "utf-8")).toBe(BUNDLED_BYTES);
  });

  it("creates the release one pipeline at a time across the repo, so a second pipeline adds to it", () => {
    expect(WORKFLOW.jobs.publish?.concurrency).toEqual({
      group: "plugin-binary-release-${{ github.ref }}",
      "cancel-in-progress": false,
    });
  });

  it("decides once what counts as a beta, so the release and the binaries cannot disagree", () => {
    expect(script("publish", "Attach the Binaries to the Release")).not.toMatch(/PRERELEASE=/);
    expect(stepNamed("publish", "Attach the Binaries to the Release").env?.PRERELEASE).toBe(
      "${{ needs.plan.outputs.prerelease }}",
    );
  });
});
