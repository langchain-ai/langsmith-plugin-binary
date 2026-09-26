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
  environment?: string;
}

const WORKFLOW = parse(
  readFileSync(new URL("../.github/workflows/build-binary.yml", import.meta.url), "utf-8"),
) as {
  on: Record<string, { inputs?: Record<string, unknown> }>;
  concurrency: { "cancel-in-progress": string };
  jobs: Record<string, Job>;
};

const PUBLISHING_GATE = "needs.plan.outputs.publishing == 'true'";
const TAG_TEST = /startsWith\(\s*github\.ref\s*,\s*'([^']*)'\s*\)/;
const APPLE_SECRET = /secrets\.(?:APPLE|CSC)_/;
const MANIFEST = ".claude-plugin/plugin.json";
const BUNDLE = "bundle/dispatch.js";
const PIPELINE_STEP = "Check Out the Scripts This Workflow Runs";
const CONFIG_STEP = "Read the Binary Config";
const VERSION_STEP = "Check the Version Matches the Tag";
const BETA_STEP = "Find the Beta Branch This Tag Belongs To";
const SIGN_STEP = "Sign and Notarize the Binary";
const PROPOSE_STEP = "Offer the Binaries to the Plugin's Beta Branch";
const GATE_STEP = "Decide Whether This Run Is Releasing";
const PIPELINE_ROOT = new URL("../", import.meta.url).pathname;
const SIGNED_PATTERN = "${{ needs.plan.outputs.executable }}-darwin-*-signed";
const BETA_BRANCH = "beta-1.2.0";
const RELEASED_TAG = "1.2.0-beta.4";
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

function stepsRunning(job: string, command: string): string[] {
  return (WORKFLOW.jobs[job]?.steps ?? [])
    .map((step) => step.run?.trim() ?? "")
    .filter((run) => run.includes(command));
}

function jobsWhere(holds: (job: Job, name: string) => boolean): string[] {
  return Object.keys(WORKFLOW.jobs).filter((name) => holds(WORKFLOW.jobs[name] ?? {}, name));
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
  const pipeline = join(cwd, stepNamed("plan", PIPELINE_STEP).with?.path ?? "");
  if (!existsSync(pipeline)) {
    mkdirSync(dirname(pipeline), { recursive: true });
    symlinkSync(PIPELINE_ROOT, pipeline, "dir");
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
  it("runs the checks from the commit the plugin pinned, not whatever a branch holds today", () => {
    expect(stepNamed("plan", PIPELINE_STEP).with).toMatchObject({
      repository: "${{ job.workflow_repository }}",
      ref: "${{ job.workflow_sha }}",
    });
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

describe("finding the beta branch a tag belongs to", () => {
  function findTheBetaBranch(
    answers: { exists?: boolean; comparison?: string } = {},
    tag = RELEASED_TAG,
  ): Record<string, string> {
    const path = scratch("plugin-binary-beta-");
    writeFileSync(
      join(path, "gh"),
      [
        "#!/bin/sh",
        'case "$2" in',
        '  */branches/*) [ "$EXISTS" = yes ] || exit 1 ;;',
        '  */compare/*) echo "$COMPARISON" ;;',
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
      EXISTS: answers.exists === false ? "no" : "yes",
      COMPARISON: answers.comparison ?? "ahead",
    });
  }

  it("works out the branch from the tag, so nobody has to name it", () => {
    expect(findTheBetaBranch()).toEqual({ branch: BETA_BRANCH });
  });

  it("stops a beta with no branch waiting for it", () => {
    expect(() => findTheBetaBranch({ exists: false })).toThrow(
      `${RELEASED_TAG} belongs to ${BETA_BRANCH}, which does not exist.`,
    );
  });

  it("stops a beta branch that is behind the work already on the default branch", () => {
    expect(() => findTheBetaBranch({ comparison: "behind" })).toThrow(
      `${BETA_BRANCH} is missing work that is already on main`,
    );
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
    const naming = publish.split("\n").find((line) => line.includes('NAME="$EXECUTABLE'));
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

  it("only publishes once the Intel run and both signings have passed", () => {
    expect(WORKFLOW.jobs.publish?.needs).toEqual(["plan", "build", "run-on-intel", "sign"]);
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
      (_job, name) =>
        handedOver(name, "download").length > 0 && stepsRunning(name, "test:binary").length > 0,
    );
    const restoresTheBit = jobsWhere((job) =>
      (job.steps ?? []).some(
        (step) => step.run?.includes("chmod +x") === true && step.if === undefined,
      ),
    );
    expect(downloadsAndRuns.filter((name) => !restoresTheBit.includes(name))).toEqual([]);
  });

  it("puts the signed binary through the same test the unsigned one passed", () => {
    expect(stepsRunning("sign", "test:binary")).toEqual(stepsRunning("build", "test:binary"));
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

function proposeTheBinaries(directory = CARRIED_DIRECTORY): { origin: string; body: string } {
  const root = scratch("plugin-binary-propose-");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const path = join(root, "path");

  git(root, "init", "--bare", `--initial-branch=${BETA_BRANCH}`, origin);
  git(root, "clone", origin, work);
  mkdirSync(join(work, CARRIED_DIRECTORY), { recursive: true });
  writeFileSync(join(work, CARRIED_DIRECTORY, ".gitkeep"), "");
  git(work, "add", "-A");
  git(work, "-c", "user.name=Seed", "-c", "user.email=s@example.invalid", "commit", "-m", "Seed");
  git(work, "push", "origin", `HEAD:refs/heads/${BETA_BRANCH}`);

  for (const [arch, bytes] of Object.entries(SIGNED_BYTES)) {
    const uploaded = join(work, "signed", `${EXECUTABLE}-darwin-${arch}-signed`);
    mkdirSync(uploaded, { recursive: true });
    writeFileSync(join(uploaded, EXECUTABLE), bytes);
  }
  mkdirSync(path);
  writeFileSync(
    join(path, "gh"),
    [
      "#!/bin/sh",
      'case "$1 $2" in',
      "  'release view') echo 'https://example.invalid/releases/tag' ;;",
      "  'pr view') exit 1 ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(path, "gh"), 0o755);

  execFileSync("/bin/bash", ["-e", "-c", script("propose", PROPOSE_STEP)], {
    cwd: work,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      PATH: `${path}:${process.env.PATH ?? ""}`,
      ...ISOLATED_GIT,
      GH_TOKEN: "unused by the stub",
      GH_REPO: "langchain-ai/example-plugins",
      BASE: BETA_BRANCH,
      DIRECTORY: directory,
      EXECUTABLE,
      TAG: RELEASED_TAG,
      RUNNER_TEMP: root,
    },
  });

  return { origin, body: readFileSync(join(root, "pull-request-body.md"), "utf-8") };
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
    expect(() => proposeTheBinaries("somewhere/else")).toThrow(
      /has no somewhere\/else folder\. Point binary-directory at the folder/,
    );
  });

  it("aims at the beta branch alone, so no existing user is moved onto a binary", () => {
    expect(stepNamed("propose", "Check Out the Plugin's Beta Branch").with?.ref).toBe(
      "${{ needs.plan.outputs.beta-branch }}",
    );
    expect(stepNamed("propose", PROPOSE_STEP).env?.BASE).toBe(
      "${{ needs.plan.outputs.beta-branch }}",
    );
    expect(JSON.stringify(WORKFLOW.jobs.propose)).not.toContain("default_branch");
  });

  it("lets no caller name a branch of its own", () => {
    expect(Object.keys(WORKFLOW.on.workflow_call?.inputs ?? {})).not.toContain("beta-branch");
  });

  it("names the tag and checksums the bytes, so a swapped binary cannot pass as the signed one", () => {
    const { body } = proposeTheBinaries();
    expect(body).toContain(`Built from tag ${RELEASED_TAG}`);
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

  it("offers nothing unless the run is releasing a beta", () => {
    const gate = (WORKFLOW.jobs.propose?.if ?? "").replace(/\s+/g, " ");
    expect(gate).toContain(PUBLISHING_GATE);
    expect(gate).toContain("needs.plan.outputs.prerelease == 'true'");
  });

  it("offers nothing that has not been through signing", () => {
    expect(stepNamed("propose", "Download the Signed Binaries").with?.pattern).toBe(SIGNED_PATTERN);
  });

  it("waits for the release, so a repository it cannot write to costs nobody the release", () => {
    expect(WORKFLOW.jobs.propose?.needs).toContain("publish");
  });

  it("decides once what counts as a beta, so the release and the binaries cannot disagree", () => {
    expect(script("publish", "Attach the Binaries to the Release")).not.toMatch(/PRERELEASE=/);
    expect(stepNamed("publish", "Attach the Binaries to the Release").env?.PRERELEASE).toBe(
      "${{ needs.plan.outputs.prerelease }}",
    );
  });
});
