import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build, buildArguments, buildPlan, outputPath, requestedArches } from "./build.js";
import { loadConfig } from "./config.js";
import { VERSION_DEFINE } from "./constants.js";
import type { BuildSteps } from "./models.js";

function planFor(consumer: string) {
  const loaded = loadConfig(
    new URL(`../test/fixtures/${consumer}/binary.config.json`, import.meta.url).pathname,
  );
  return { loaded, plan: buildPlan(loaded) };
}

function definesIn(args: string[]): Record<string, string> {
  return Object.fromEntries(
    args.flatMap((arg, index) =>
      arg === "--define" ? [args[index + 1]!.split(/=(.*)/s) as [string, string]] : [],
    ),
  );
}

describe("planning a build", () => {
  it("builds exactly the chips the plugin publishes for", () => {
    const { loaded, plan } = planFor("claude-code");
    expect(plan.arches).toEqual(loaded.config.publishedTargets[plan.platform]);
    expect(plan.arches).toEqual(["arm64", "x64"]);
  });

  it("reads the version from the file the repository releases from", () => {
    expect(planFor("claude-code").plan.version).toBe("0.3.1");
    expect(planFor("codex").plan.version).toBe("0.2.0-beta");
  });

  it("refuses a version file with no version in it", () => {
    const { loaded } = planFor("claude-code");
    loaded.config.build.versionFile = "hooks/hooks.binary.json";
    expect(() => buildPlan(loaded)).toThrow("declares no version");
  });

  it("refuses to guess when a plugin publishes for more than one system", () => {
    const { loaded } = planFor("claude-code");
    loaded.config.publishedTargets = { darwin: ["arm64"], linux: ["x64"] };
    expect(() => buildPlan(loaded)).toThrow("one platform at a time");
  });
});

describe("choosing what to build", () => {
  const { plan } = planFor("claude-code");

  it("builds this machine's chip when nothing is asked for", () => {
    expect(requestedArches(plan, [])).toEqual([process.arch]);
  });

  it("builds every published chip when asked for all of them", () => {
    expect(requestedArches(plan, ["--arch=all"])).toEqual(["arm64", "x64"]);
  });

  it.each(["arm64", "x64"])("builds only %s when it is the one named", (arch) => {
    expect(requestedArches(plan, [`--arch=${arch}`])).toEqual([arch]);
  });

  it("refuses a chip nothing is published for", () => {
    expect(() => requestedArches(plan, ["--arch=ia32"])).toThrow(
      "Unsupported architecture ia32, expected one of arm64, x64, all",
    );
  });
});

describe("where the built binary lands", () => {
  const { plan } = planFor("claude-code");
  const other = plan.arches.find((arch) => arch !== process.arch)!;

  it("puts this machine's build where the signer looks for it, under the installed name", () => {
    expect(outputPath(plan, process.arch)).toBe(
      join(plan.outputDirectory, "langsmith-claude-code-tracing"),
    );
  });

  it("keeps a cross compiled build in a folder of its own", () => {
    expect(outputPath(plan, other)).toBe(
      join(plan.outputDirectory, `darwin-${other}`, "langsmith-claude-code-tracing"),
    );
  });
});

describe("the command handed to Bun", () => {
  const { plan } = planFor("claude-code");

  it.each(["arm64", "x64"])("targets %s and writes that chip's own file", (arch) => {
    const args = buildArguments(plan, arch, "out");
    expect(args.slice(0, 3)).toEqual(["build", "--compile", `--target=bun-darwin-${arch}`]);
    expect(args.slice(-2)).toEqual(["--outfile", "out"]);
    expect(args).toContain(plan.entryPoint);
  });

  it("writes the version in the form Bun reads, not the one esbuild reads", () => {
    const args = buildArguments(plan, "arm64", "out");
    expect(JSON.parse(definesIn(args)[VERSION_DEFINE]!)).toBe("0.3.1");
    expect(args.some((arg) => arg.startsWith("--define:") || arg.startsWith("--define="))).toBe(
      false,
    );
  });

  it("carries every extra value the plugin asked to be compiled in", () => {
    const { plan: withHooks } = planFor("claude-code");
    const inlined = JSON.parse(
      JSON.parse(definesIn(buildArguments(withHooks, "arm64", "out"))["__LS_BINARY_HOOKS__"]!),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(inlined.hooks)).toHaveLength(9);
  });

  it("leaves out an extra value the plugin did not ask for", () => {
    const args = buildArguments(planFor("codex").plan, "arm64", "out");
    expect(Object.keys(definesIn(args))).toEqual([VERSION_DEFINE]);
  });

  it("minifies only when the plugin asks for it", () => {
    expect(buildArguments(planFor("codex").plan, "arm64", "out")).toContain("--minify");
    expect(buildArguments(planFor("claude-code").plan, "arm64", "out")).not.toContain("--minify");
  });
});

function stepsRecording(taken: string[]): BuildSteps {
  return {
    compile: (_plan, _arch, binary) => {
      writeFileSync(binary, "compiled");
      taken.push("compile");
    },
    checkArch: () => taken.push("arch"),
    signAdHoc: () => taken.push("sign"),
    checkVersion: () => taken.push("version"),
  };
}

function stepsTaken(argv: string[]): string[] {
  const { loaded } = planFor("claude-code");
  loaded.config.publishedTargets = { [process.platform]: ["arm64", "x64"] };
  loaded.config.build.outputDirectory = mkdtempSync(join(tmpdir(), "plugin-binary-run-"));
  const taken: string[] = [];
  build(loaded, argv, () => {}, stepsRecording(taken));
  return taken;
}

describe("what a build run does to each binary", () => {
  it("refuses to run on a machine the plugin publishes nothing for", () => {
    const { loaded } = planFor("claude-code");
    const taken: string[] = [];
    loaded.config.publishedTargets = { sunos: ["arm64"] };
    expect(() => build(loaded, [], () => {}, stepsRecording(taken))).toThrow(
      `Unsupported build host ${process.platform}, only sunos is built`,
    );
    expect(taken).toEqual([]);
  });

  it("checks the chip of every binary it builds", () => {
    expect(stepsTaken(["--arch=all"]).filter((step) => step === "arch")).toHaveLength(2);
  });

  it("checks the version of the one it can run, after signing it", () => {
    expect(stepsTaken([])).toEqual(["compile", "arch", "sign", "version"]);
  });
});
