import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "./config.js";
import { renderInstaller } from "./install-script.js";

const CONSUMERS = ["codex", "claude-code"] as const;
const AWKWARD_HELP_LINE = 'run "$HOME/bin/plugin" and `whoami` \\ now';

function fixture(consumer: string, file: string): string {
  return new URL(`../test/fixtures/${consumer}/${file}`, import.meta.url).pathname;
}

function codexConfig() {
  return loadConfig(fixture("codex", "binary.config.json")).config;
}

function helpFor(installer: string): string {
  const script = join(mkdtempSync(join(tmpdir(), "plugin-binary-render-")), "install.sh");
  writeFileSync(script, installer);
  execFileSync("/bin/bash", ["-n", script]);
  return execFileSync("/bin/bash", [script, "--help"], { encoding: "utf-8" });
}

describe.each(CONSUMERS)("the %s installer", (consumer) => {
  it("is reproduced byte for byte from its config", () => {
    const { config } = loadConfig(fixture(consumer, "binary.config.json"));
    expect(renderInstaller(config)).toBe(readFileSync(fixture(consumer, "install.sh"), "utf-8"));
  });
});

describe("rendering an installer", () => {
  it("refuses a template placeholder nothing fills", () => {
    expect(() => renderInstaller(codexConfig(), "EXECUTABLE=@EXECUTABLE@\nARCH=@ARCH@\n")).toThrow(
      "@ARCH@",
    );
  });

  it("survives quotes and shell expansions in the help text", () => {
    const config = codexConfig();
    config.installer.helpFooter = [AWKWARD_HELP_LINE];
    expect(helpFor(renderInstaller(config))).toContain(AWKWARD_HELP_LINE);
  });

  it("survives quotes and shell expansions in the platform help", () => {
    const config = codexConfig();
    config.installer.unsupportedPlatformHelp = [AWKWARD_HELP_LINE];
    const platformHelp = renderInstaller(config)
      .split("\n")
      .find((line) => line.includes("whoami"));
    expect(platformHelp).toBe('run \\"\\$HOME/bin/plugin\\" and \\`whoami\\` \\\\ now"');
  });
});

describe("reading a binary config", () => {
  const valid = JSON.parse(readFileSync(fixture("codex", "binary.config.json"), "utf-8"));

  function withInstaller(overrides: Record<string, unknown>) {
    return { ...valid, installer: { ...valid.installer, ...overrides } };
  }

  it("refuses an output path that leaves the repository", () => {
    expect(() => parseConfig(withInstaller({ output: "../../install.sh" }))).toThrow(
      "installer.output",
    );
  });

  it("refuses a prefix that is not a shell variable name", () => {
    expect(() => parseConfig(withInstaller({ environmentPrefix: "LANG SMITH" }))).toThrow(
      "installer.environmentPrefix",
    );
  });

  it("refuses help text that would close the help block early", () => {
    expect(() => parseConfig(withInstaller({ helpFooter: ["fine", "HELP", "hidden"] }))).toThrow(
      "helpFooter",
    );
  });

  it("refuses a second line of help text that would run as a command", () => {
    expect(() => parseConfig(withInstaller({ productName: "Codex\nHELP\nid" }))).toThrow(
      "installer.productName",
    );
  });

  it("refuses a binary name that would break out of the script", () => {
    expect(() => parseConfig({ ...valid, executableName: 'boom" ; id ; x="' })).toThrow(
      "executableName",
    );
  });

  it("refuses a repository that is not an owner and a name", () => {
    expect(() => parseConfig({ ...valid, repository: 'langchain-ai" ; id ; x="' })).toThrow(
      "repository",
    );
  });
});
