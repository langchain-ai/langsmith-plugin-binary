import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lockPluginFields,
  mergeCommonConfig,
  readManagedConfigFile,
  type CommonConfig,
  type CommonConfigResult,
} from "./index.js";

vi.mock("node:fs", { spy: true });
vi.mock("node:os", { spy: true });

const posix = process.platform !== "win32";
const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const uid = posix ? process.getuid!() : 0;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function managedFile(value: unknown): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "managed config "));
  fs.chmodSync(dir, 0o755);
  const path = join(dir, "managed.json");
  fs.writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  fs.chmodSync(path, 0o644);
  return path;
}

function homeWith(value: unknown): string {
  const home = fs.mkdtempSync(join(os.tmpdir(), "home "));
  fs.mkdirSync(join(home, ".langsmith-plugins"), { mode: 0o755 });
  fs.renameSync(managedFile(value), join(home, ".langsmith-plugins", "managed.json"));
  return home;
}

const locked = {
  api_url: "https://locked.example",
  replicas: [],
  redact: true,
  redact_extra_rules: [{ pattern: "secret" }],
};
const override: CommonConfig = {
  api_key: "user-key",
  api_url: "https://attacker.example",
  replicas: [{ api_url: "https://attacker.example" }],
  redact: false,
  redact_extra_rules: [],
};

describe.skipIf(!posix)("managed config lock", () => {
  it("beats every other source for the locked keys, warns per source and leaves the api key alone", () => {
    const managed = readManagedConfigFile({ path: managedFile(locked), ownerUid: uid });
    const merged = mergeCommonConfig({
      managed,
      env: { ...override, enabled: true },
      harness: override,
      root: override,
      user: { api_url: locked.api_url, replicas: [] },
      userRoot: override,
    });
    expect(merged).toMatchObject({ ...locked, api_key: "user-key", enabled: true });
    expect(new Set(merged.locked)).toEqual(
      new Set(["api_url", "redact", "redact_extra_rules", "replicas"]),
    );
    const everyOverride = "env, harness, root, userRoot";
    expect(merged.diagnostics).toEqual([
      `Ignored settings the managed config locks: api_url from ${everyOverride}; ` +
        `redact from ${everyOverride}; replicas from ${everyOverride}; ` +
        `redact_extra_rules from ${everyOverride}.`,
    ]);
  });

  it("locks replicas to none when only the endpoint is locked, whoever read the file", () => {
    const common = { api_url: locked.api_url };
    const managed: CommonConfigResult = { status: "valid", common, diagnostics: [] };
    const merged = mergeCommonConfig({ managed, env: override });
    expect(merged).toMatchObject({ api_url: locked.api_url, replicas: [] });
    expect(merged.locked).toEqual(["api_url", "replicas"]);
  });

  it("keeps a locked API key on the default server so a repo can't send it elsewhere", () => {
    const managed: CommonConfigResult = {
      status: "valid",
      common: { api_key: "k" },
      diagnostics: [],
    };
    const root = {
      api_url: "https://elsewhere.example",
      replicas: [{ api_url: "https://elsewhere.example" }],
    };
    const merged = mergeCommonConfig({ managed, root });
    expect(merged).toMatchObject({ api_url: "https://api.smith.langchain.com", replicas: [] });
    expect(merged.diagnostics).toEqual([expect.stringContaining("api_url from root")]);
  });

  it("keeps locked replicas on the default server so a repo can't collect their keys", () => {
    const common = { replicas: [{ api_key: "replica-key" }] };
    const managed: CommonConfigResult = { status: "valid", common, diagnostics: [] };
    const merged = mergeCommonConfig({ managed, root: { api_url: "https://elsewhere.example" } });
    expect(merged.api_url).toBe("https://api.smith.langchain.com");
    expect(merged.diagnostics).toEqual([expect.stringContaining("api_url from root")]);
  });

  it("drops config replicas when only the project is locked, and says so", () => {
    const managed: CommonConfigResult = {
      status: "valid",
      common: { project: "locked" },
      diagnostics: [],
    };
    const merged = mergeCommonConfig({
      managed,
      root: { replicas: [{ api_key: "k", project: "evil" }] },
    });
    expect(merged).toMatchObject({ project: "locked", replicas: [] });
    expect(merged.diagnostics).toEqual([expect.stringContaining("replicas from root")]);
  });

  it("keeps redaction on when only the redaction rules are locked, whoever read the file", () => {
    const common = { redact_extra_rules: locked.redact_extra_rules };
    const managed: CommonConfigResult = { status: "valid", common, diagnostics: [] };
    const merged = mergeCommonConfig({ managed, env: override });
    expect(merged).toMatchObject({ redact: true, redact_extra_rules: locked.redact_extra_rules });
    expect(new Set(merged.locked)).toEqual(new Set(["redact", "redact_extra_rules"]));
  });

  it("lets the managed file keep the login browser off over every other source", () => {
    const managed = readManagedConfigFile({
      path: managedFile({ login_browser: false }),
      ownerUid: uid,
    });
    const merged = mergeCommonConfig({
      managed,
      env: { login_browser: true },
      user: { login_browser: true },
    });
    expect(merged.login_browser).toBe(false);
    expect(merged.locked).toEqual(["login_browser"]);
  });

  it("lets the managed file lock the notice cooldown and rejects a value that isn't minutes or off", () => {
    const managed = readManagedConfigFile({
      path: managedFile({ notice_cooldown: "off" }),
      ownerUid: uid,
    });
    expect(mergeCommonConfig({ managed, user: { notice_cooldown: 10 } }).notice_cooldown).toBe(
      "off",
    );
    const wrong = readManagedConfigFile({
      path: managedFile({ notice_cooldown: "soon" }),
      ownerUid: uid,
    });
    expect(wrong.status).toBe("invalid");
    const negative = readManagedConfigFile({
      path: managedFile({ notice_cooldown: -1 }),
      ownerUid: uid,
    });
    expect(negative.status).toBe("invalid");
  });

  it("hands a plugin its own locked fields and warns about ones it can't lock", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const path = managedFile({ project: "p", attachments: false, cursor_db_path: "/db" });
    const fields = lockPluginFields(readManagedConfigFile({ path, ownerUid: uid }), {
      lockable: ["attachments", "system_prompt"],
      unlockable: ["cursor_db_path"],
    });
    expect(fields).toStrictEqual({ attachments: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cursor_db_path"));
    const untrusted = readManagedConfigFile({ path, ownerUid: uid + 1 });
    expect(lockPluginFields(untrusted, { lockable: ["attachments"] })).toStrictEqual({});
  });

  it("locks every field the file sets, merging only the metadata keys it leaves open", () => {
    const path = managedFile({
      api_key: "managed-key",
      project: "managed-project",
      enabled: true,
      metadata: { team: "platform" },
      unknown_field: "ignored",
    });
    const managed = readManagedConfigFile({ path, ownerUid: uid });
    const merged = mergeCommonConfig({
      managed,
      env: { api_key: "user-key", enabled: false, metadata: { team: "rogue", laptop: "x" } },
      user: { project: "user-project", metadata: { laptop: "x" } },
    });
    expect(merged).toMatchObject({
      api_key: "managed-key",
      project: "managed-project",
      enabled: true,
      metadata: { team: "platform", laptop: "x" },
    });
    expect(new Set(merged.locked)).toEqual(
      new Set(["api_key", "api_url", "enabled", "metadata", "project", "replicas"]),
    );
    const envFirst = mergeCommonConfig({ managed, env: { enabled: false } }, { envFirst: true });
    expect(envFirst.enabled).toBe(true);
    expect(merged.diagnostics).toEqual([
      "Ignored settings the managed config locks: enabled from env; api_key from env; " +
        "project from user; metadata from env.",
    ]);
  });

  it.each([
    ["another owner", (path: string) => path, uid + 1],
    ["a group-writable file", (path: string) => (fs.chmodSync(path, 0o664), path), uid],
    [
      "a world-writable folder",
      (path: string) => (fs.chmodSync(join(path, ".."), 0o757), path),
      uid,
    ],
    [
      "a symlinked file",
      (path: string) => {
        const target = join(fs.mkdtempSync(join(os.tmpdir(), "target ")), "managed.json");
        fs.renameSync(path, target);
        fs.symlinkSync(target, path);
        return path;
      },
      uid,
    ],
    [
      "a symlinked folder",
      (path: string) => {
        const link = join(fs.mkdtempSync(join(os.tmpdir(), "link ")), "folder");
        fs.symlinkSync(join(path, ".."), link);
        return join(link, "managed.json");
      },
      uid,
    ],
  ])("turns tracing off for %s", (_, tamper, ownerUid) => {
    const managed = readManagedConfigFile({ path: tamper(managedFile(locked)), ownerUid });
    const merged = mergeCommonConfig({ managed, env: { ...override, enabled: true } });
    expect(merged).toMatchObject({ enabled: false, locked: [] });
    expect(merged.managedConfigProblem).toMatch(/aren't owned by root/);
  });

  it.each(["{", "null", '{"api_url":5}'])("turns tracing off for broken file %s", (text) => {
    const managed = readManagedConfigFile({ path: managedFile(text), ownerUid: uid });
    const merged = mergeCommonConfig({ managed, env: { ...override, enabled: true } });
    expect(merged).toMatchObject({ enabled: false, locked: [] });
    expect(merged.managedConfigProblem).toMatch(/managed settings are invalid/);
  });

  it.skipIf(uid === 0)("turns tracing off for a file it cannot open", () => {
    const path = managedFile(locked);
    fs.chmodSync(path, 0o000);
    const merged = mergeCommonConfig({
      managed: readManagedConfigFile({ path, ownerUid: uid }),
      env: { enabled: true },
    });
    expect(merged).toMatchObject({ enabled: false, locked: [] });
    expect(merged.diagnostics).toEqual([expect.stringMatching(/managed settings are invalid/)]);
  });

  it.skipIf(uid === 0)("requires root to own the file unless told otherwise", () => {
    expect(readManagedConfigFile({ path: managedFile(locked) }).status).toBe("invalid");
  });

  it("reads a file saved with a byte order mark", () => {
    const path = managedFile(`\uFEFF${JSON.stringify(locked)}`);
    expect(readManagedConfigFile({ path, ownerUid: uid }).common).toEqual(locked);
  });

  it("finds the file from the account's home rather than the HOME variable", () => {
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: homeWith(locked) });
    vi.stubEnv("HOME", homeWith({ api_url: "https://other.example" }));
    expect(readManagedConfigFile({ ownerUid: uid }).common.api_url).toBe(locked.api_url);
  });

  it("falls back to the HOME folder when the account's home cannot be looked up", () => {
    vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
      throw new Error("no account");
    });
    vi.stubEnv("HOME", homeWith(locked));
    expect(readManagedConfigFile({ ownerUid: uid }).common.api_url).toBe(locked.api_url);
  });

  it.skipIf(!hasBun)(
    "finds the account's home in a compiled binary even with HOME pointed elsewhere",
    () => {
      vi.mocked(os.userInfo).mockReset();
      const dir = fs.mkdtempSync(join(os.tmpdir(), "compiled lookup "));
      const reader = fileURLToPath(new URL("./managed-config.ts", import.meta.url));
      const entry = join(dir, "entry.ts");
      const binary = join(dir, "reader");
      fs.writeFileSync(
        entry,
        `import { readManagedConfigFile } from ${JSON.stringify(reader)};\n` +
          "console.log(JSON.stringify(readManagedConfigFile()));\n",
      );
      execFileSync("bun", ["build", "--compile", entry, "--outfile", binary], { stdio: "ignore" });
      const home = homeWith({ api_url: "https://attacker.example" });
      const output = execFileSync(binary, {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      expect(JSON.parse(output)).toEqual(readManagedConfigFile());
    },
    60_000,
  );

  it("reads the file it checked even if it is swapped right after opening", () => {
    const path = managedFile(locked);
    const swap = join(path, "..", "swap.json");
    fs.writeFileSync(swap, JSON.stringify({ api_url: "https://attacker.example" }));
    fs.chmodSync(swap, 0o664);
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementationOnce((...args) => {
      const fd = open(...args);
      fs.renameSync(swap, path);
      return fd;
    });
    expect(readManagedConfigFile({ path, ownerUid: uid }).common.api_url).toBe(locked.api_url);
  });

  it("does not read the file on Windows", () => {
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: homeWith(locked) });
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(readManagedConfigFile({ ownerUid: uid }).status).toBe("absent");
  });

  it("locks nothing and keeps tracing on when there is no managed file", () => {
    const missing = join(fs.mkdtempSync(join(os.tmpdir(), "managed config ")), "managed.json");
    const managed = readManagedConfigFile({ path: missing });
    const merged = mergeCommonConfig({ managed, env: { enabled: true } });
    expect(merged).toMatchObject({ enabled: true, locked: [], diagnostics: [] });
    expect(merged).not.toHaveProperty("managedConfigProblem");
  });

  it("reads the account's managed file itself when a plugin passes none", () => {
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: homeWith(locked) });
    const merged = mergeCommonConfig({ env: { enabled: true } });
    expect(merged).toMatchObject({ enabled: false, locked: [] });
    expect(merged.managedConfigProblem).toMatch(/aren't owned by root/);
  });

  it("warns about each managed config notice once however often settings load", async () => {
    vi.resetModules();
    const fresh = await import("./index.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const managed = fresh.readManagedConfigFile({ path: managedFile(locked), ownerUid: uid });
    for (let load = 0; load < 3; load++) fresh.mergeCommonConfig({ managed, env: override });
    expect(warn.mock.calls.map(([line]) => line)).toEqual(
      fresh.mergeCommonConfig({ managed, env: override }).diagnostics,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
