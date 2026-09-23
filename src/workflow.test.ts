import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { defineBinaryTarget } from "./binary.js";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: { name?: string; pattern?: string };
}

interface Job {
  steps?: Step[];
  strategy?: { matrix?: { include?: { arch: string; runner: string }[] } };
  needs?: string[];
}

const WORKFLOW = parse(
  readFileSync(new URL("../.github/workflows/build-binary.yml", import.meta.url), "utf-8"),
) as { jobs: Record<string, Job> };

function fixtureRoot(consumer: string): string {
  return new URL(`../test/fixtures/${consumer}/`, import.meta.url).pathname;
}

function handedOver(job: string, action: string): string[] {
  return (WORKFLOW.jobs[job]?.steps ?? [])
    .filter((step) => step.uses?.startsWith(`actions/${action}-artifact@`) === true)
    .map((step) => step.with?.name ?? "");
}

function stepNamed(job: string, step: string): Step {
  const found = WORKFLOW.jobs[job]?.steps?.find((candidate) => candidate.name === step);
  if (found === undefined) throw new Error(`the workflow has no ${job} step named ${step}`);
  return found;
}

function script(job: string, step: string): string {
  return stepNamed(job, step).run ?? "";
}

function runStep(
  job: string,
  step: string,
  consumer: string,
  env: Record<string, string> = {},
  cwd = fixtureRoot(consumer),
): Record<string, string> {
  const outputFile = join(mkdtempSync(join(tmpdir(), "plugin-binary-workflow-")), "output");
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
  it("finds where Claude Code's build leaves each binary", () => {
    expect(runStep("plan", "Read the Binary Config", "claude-code")).toEqual({
      executable: "langsmith-claude-code-tracing",
      "output-directory": "bin",
      "host-binary": "bin/langsmith-claude-code-tracing",
      "cross-binary": "bin/darwin-x64/langsmith-claude-code-tracing",
    });
  });

  it("finds where Codex's build leaves each binary", () => {
    expect(runStep("plan", "Read the Binary Config", "codex")).toEqual({
      executable: "langsmith-codex-tracing",
      "output-directory": "plugins/tracing/bin",
      "host-binary": "plugins/tracing/bin/langsmith-codex-tracing",
      "cross-binary": "plugins/tracing/bin/darwin-x64/langsmith-codex-tracing",
    });
  });

  it("finds a plugin that keeps its config in a folder", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-binary-workflow-"));
    cpSync(fixtureRoot("claude-code"), join(root, "tools"), { recursive: true });
    expect(
      runStep(
        "plan",
        "Read the Binary Config",
        "claude-code",
        {
          CONFIG: "tools/binary.config.json",
        },
        root,
      ),
    ).toEqual({
      executable: "langsmith-claude-code-tracing",
      "output-directory": "tools/bin",
      "host-binary": "tools/bin/langsmith-claude-code-tracing",
      "cross-binary": "tools/bin/darwin-x64/langsmith-claude-code-tracing",
    });
  });

  it("builds and signs from the config the plan read", () => {
    for (const [job, step] of [
      ["plan", "Read the Binary Config"],
      ["build", "Build the Unsigned Binaries"],
      ["sign", "Sign and Notarize the Binary"],
    ] as const) {
      expect(stepNamed(job, step).env?.CONFIG).toBe("${{ inputs.config }}");
    }
    expect(script("build", "Build the Unsigned Binaries")).toContain('--config "$CONFIG"');
    expect(script("sign", "Sign and Notarize the Binary")).toContain('--config "$CONFIG"');
  });

  it("stops when a plugin asks for a chip this pipeline cannot build", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-binary-workflow-"));
    const config = JSON.parse(
      readFileSync(join(fixtureRoot("codex"), "binary.config.json"), "utf-8"),
    ) as Record<string, unknown>;
    config.publishedTargets = { linux: ["x64"] };
    writeFileSync(join(root, "binary.config.json"), JSON.stringify(config));
    expect(() =>
      execFileSync("/bin/bash", ["-e", "-c", script("plan", "Read the Binary Config")], {
        cwd: root,
        stdio: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          CONFIG: "binary.config.json",
          GITHUB_OUTPUT: "/dev/null",
        },
      }),
    ).toThrow();
  });
});

describe("checking the tag against the version", () => {
  it("lets a tag through that matches the version being released", () => {
    expect(() =>
      runStep("plan", "Check the Version Matches the Tag", "claude-code", { TAG: "0.3.1" }),
    ).not.toThrow();
  });

  it("stops a tag that does not match", () => {
    expect(() =>
      runStep("plan", "Check the Version Matches the Tag", "claude-code", { TAG: "9.9.9" }),
    ).toThrow();
  });

  it("reads the version from wherever each plugin keeps it", () => {
    expect(() =>
      runStep("plan", "Check the Version Matches the Tag", "codex", { TAG: "0.2.0-beta" }),
    ).not.toThrow();
  });
});

describe("the names the pipeline publishes under", () => {
  const publish = script("publish", "Attach the Binaries to the Release");

  it("uploads exactly the file the install script and the updater download", () => {
    const codex = defineBinaryTarget({
      executableName: "langsmith-codex-tracing",
      repository: "langchain-ai/langsmith-codex-plugins",
      userAgent: "langsmith-codex",
      releasesApiOverrideEnvVar: "LANGSMITH_CODEX_RELEASES_API",
    });
    const named = execFileSync(
      "/bin/bash",
      [
        "-c",
        `${publish.split("\n").find((line) => line.includes('NAME="$EXECUTABLE'))!}; printf '%s' "$NAME"`,
      ],
      {
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH ?? "",
          EXECUTABLE: "langsmith-codex-tracing",
          ARCH: "arm64",
          TAG: "0.6.0",
        },
      },
    );
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
    expect(stepNamed("publish", "Download the Signed Binaries").with?.pattern).toBe(
      "${{ needs.plan.outputs.executable }}-darwin-*-signed",
    );
  });

  it("never lets a signing run turn itself off", () => {
    expect(stepNamed("sign", "Sign and Notarize the Binary").if).toBeUndefined();
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
