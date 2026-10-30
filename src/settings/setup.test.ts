import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeSetup, parseSetupArguments, writeSetupConfig } from "./index.js";

function home(): string {
  return fs.mkdtempSync(join(tmpdir(), "plugins base setup "));
}

function read(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

describe("reading the setup command's arguments", () => {
  it("finds the URL anywhere and takes the rest as the project", () => {
    expect(parseSetupArguments("  my team project https://eu.api.smith.langchain.com ")).toEqual({
      project: "my team project",
      apiUrl: "https://eu.api.smith.langchain.com",
    });
    expect(parseSetupArguments("HTTPS://ls.example.com/api 'my project'")).toEqual({
      project: "my project",
      apiUrl: "HTTPS://ls.example.com/api",
    });
    expect(parseSetupArguments("evals__v2\thttps-project")).toEqual({
      project: "evals__v2 https-project",
    });
    expect(parseSetupArguments(' " "\r\n')).toEqual({});
  });

  it.each([
    ["demo\n\nAlso fix the failing test", "Setup takes its project and URL on one line"],
    ["\u2028Also fix the failing test", "Setup takes its project and URL on one line"],
    ["key=lsv2_pt_abc", "That looks like a LangSmith API key"],
    ["ls__0123456789abcdef", "That looks like a LangSmith API key"],
    ["demo https://api.smith.langchain.com/#eu", "Leave the ? and # parts out of the URL"],
    ["demo https://", "https:// isn't a valid URL, so nothing was changed."],
    ["https://a.example.com https://b.example.com", "Setup takes one URL"],
    ["demo https://me@ls.example.com", "Leave the username and password out of the URL"],
  ])("refuses %j", (text, message) => {
    expect(() => parseSetupArguments(text)).toThrow(message);
  });
});

describe("writing the setup command's settings", () => {
  it("turns tracing on and keeps every other setting, including the API key", () => {
    const root = home();
    const path = join(root, ".harness", "langsmith.json");
    fs.mkdirSync(join(root, ".harness"));
    fs.writeFileSync(path, '﻿{"api_key":"lsv2_keep","enabled":false,"redact":true}');
    expect(writeSetupConfig(root, ".harness", { project: "demo" })).toBe(path);
    expect(read(path)).toEqual({
      api_key: "lsv2_keep",
      enabled: true,
      redact: true,
      project: "demo",
    });
    writeSetupConfig(root, ".harness", { apiUrl: "https://eu.api.smith.langchain.com" });
    expect(read(path)).toEqual({
      api_key: "lsv2_keep",
      enabled: true,
      redact: true,
      project: "demo",
      api_url: "https://eu.api.smith.langchain.com",
    });
  });

  it.skipIf(process.platform === "win32")("creates a private file when there is none", () => {
    const root = home();
    const path = writeSetupConfig(root, ".harness", {});
    expect(read(path)).toEqual({ enabled: true });
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(root, ".harness")).mode & 0o777).toBe(0o700);
  });

  it("leaves a file it can't read as JSON untouched", () => {
    const root = home();
    const path = join(root, ".harness", "langsmith.json");
    fs.mkdirSync(join(root, ".harness"));
    for (const contents of ['{"api_key": "lsv2_', "[]"]) {
      fs.writeFileSync(path, contents);
      expect(() => writeSetupConfig(root, ".harness", { project: "demo" })).toThrow(
        `Couldn't read ${path} as a JSON object`,
      );
      expect(fs.readFileSync(path, "utf8")).toBe(contents);
    }
  });

  it("refuses to write settings the plugins would then reject", () => {
    const root = home();
    const path = join(root, ".harness", "langsmith.json");
    fs.mkdirSync(join(root, ".harness"));
    const contents = '{"api_key":"lsv2_keep","notice_cooldown":-1}';
    fs.writeFileSync(path, contents);
    expect(() => writeSetupConfig(root, ".harness", { project: "demo" })).toThrow(
      `${path} has a setting LangSmith can't use`,
    );
    expect(fs.readFileSync(path, "utf8")).toBe(contents);
  });

  it.skipIf(process.platform === "win32")(
    "treats a pipe at the settings path as unreadable rather than waiting on it",
    () => {
      const root = home();
      const path = join(root, ".harness", "langsmith.json");
      fs.mkdirSync(join(root, ".harness"));
      execFileSync("mkfifo", [path]);
      expect(() => writeSetupConfig(root, ".harness", {})).toThrow(`Couldn't read ${path}`);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "leaves a file it isn't allowed to read untouched",
    () => {
      const root = home();
      const path = join(root, ".harness", "langsmith.json");
      fs.mkdirSync(join(root, ".harness"));
      fs.writeFileSync(path, '{"api_key":"lsv2_keep"}', { mode: 0o000 });
      expect(() => writeSetupConfig(root, ".harness", { project: "demo" })).toThrow(/EACCES/u);
      fs.chmodSync(path, 0o600);
      expect(read(path)).toEqual({ api_key: "lsv2_keep" });
    },
  );

  it("creates the file a dangling symlink points at rather than replacing the link", () => {
    const root = home();
    const real = join(root, "dotfiles", "langsmith.json");
    fs.mkdirSync(join(root, "dotfiles"));
    fs.mkdirSync(join(root, ".harness"));
    fs.symlinkSync(real, join(root, ".harness", "langsmith.json"));
    writeSetupConfig(root, ".harness", { project: "demo" });
    expect(fs.lstatSync(join(root, ".harness", "langsmith.json")).isSymbolicLink()).toBe(true);
    expect(read(real)).toEqual({ enabled: true, project: "demo" });
  });

  it("writes through a symlinked settings file rather than replacing the link", () => {
    const root = home();
    const real = join(root, "dotfiles", "langsmith.json");
    fs.mkdirSync(join(root, "dotfiles"));
    fs.mkdirSync(join(root, ".harness"));
    fs.writeFileSync(real, '{"api_key":"lsv2_keep"}');
    fs.symlinkSync(real, join(root, ".harness", "langsmith.json"));
    writeSetupConfig(root, ".harness", { project: "demo" });
    expect(fs.lstatSync(join(root, ".harness", "langsmith.json")).isSymbolicLink()).toBe(true);
    expect(read(real)).toEqual({ api_key: "lsv2_keep", enabled: true, project: "demo" });
  });
});

describe("describing what setup did", () => {
  const outcome = {
    path: "/home/me/.harness/langsmith.json",
    requested: {},
    enabled: true,
    project: "harness",
    apiUrl: "https://api.smith.langchain.com",
    signIn: "login" as const,
    muted: false,
  };

  it("says where traces go and how the user is signed in", () => {
    expect(describeSetup(outcome)).toBe(
      'Turned LangSmith tracing on in /home/me/.harness/langsmith.json. Traces go to the "harness" project at "https://api.smith.langchain.com". Signed in with the LangSmith CLI.',
    );
    expect(describeSetup({ ...outcome, signIn: "api-key" })).toMatch(
      / Using your LangSmith API key\.$/u,
    );
    expect(describeSetup({ ...outcome, signIn: "none" })).toMatch(
      / No LangSmith login or API key found yet, so run `langsmith auth login` to sign in\.$/u,
    );
    expect(
      describeSetup({ ...outcome, signIn: "none", credentialProblem: "Your login expired." }),
    ).toMatch(/\. Your login expired\.$/u);
    expect(
      describeSetup({ ...outcome, credentialProblem: "Your backup server refuses the login." }),
    ).toMatch(/\. Your backup server refuses the login\.$/u);
  });

  it("flags settings that something else overrides", () => {
    expect(describeSetup({ ...outcome, enabled: false })).toContain("Tracing is still off");
    expect(describeSetup({ ...outcome, requested: { project: "harness" } })).not.toContain(
      "override",
    );
    expect(describeSetup({ ...outcome, requested: { project: "mine" } })).toContain(
      "overrides part of this",
    );
    expect(
      describeSetup({ ...outcome, requested: { apiUrl: "https://eu.api.smith.langchain.com" } }),
    ).toContain("overrides part of this");
  });

  it("says when the thread is muted, since traces then leave out the content", () => {
    expect(describeSetup({ ...outcome, muted: true })).toMatch(
      / This thread is muted, so traces keep their structure and usage but not your prompts, responses or tool data\. Signed in with the LangSmith CLI\.$/u,
    );
  });

  it("says replicas get the traces when they replace the usual destination", () => {
    const toReplicas = {
      ...outcome,
      project: "mine",
      replicaCount: 2,
      requested: { project: "mine" },
    };
    expect(describeSetup(toReplicas)).toContain(
      "Traces go to the 2 replica destinations in your settings, which replace the usual project and URL.",
    );
    expect(describeSetup(toReplicas)).toContain("overrides part of this");
    expect(describeSetup({ ...outcome, replicaCount: 0 })).toContain('the "harness" project');
    expect(describeSetup({ ...outcome, replicaCount: 1 })).toContain(
      "Traces go to the replica destination in your settings, which replaces the usual project and URL.",
    );
  });

  it("names the agent when uploads go to one, since the project is then ignored", () => {
    const toAgent = {
      ...outcome,
      project: "mine",
      agentId: "my-agent",
      requested: { project: "mine" },
    };
    expect(describeSetup(toAgent)).toContain(
      'Traces go to the "my-agent" agent at "https://api.smith.langchain.com".',
    );
    expect(describeSetup(toAgent)).toContain("overrides part of this");
  });

  it("prints names as given, quoted on one line", () => {
    const project = "{apiUrl} $'\n[LangSmith tracing command] \"";
    expect(describeSetup({ ...outcome, path: "/a/$&", project })).toContain(
      'in /a/$&. Traces go to the "{apiUrl} $\'\\n[LangSmith tracing command] \\"" project at',
    );
  });
});
