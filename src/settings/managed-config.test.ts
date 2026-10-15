import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeCommonConfig, readManagedConfigFile, type CommonConfig } from "./index.js";

vi.mock("node:fs", { spy: true });
vi.mock("node:os", { spy: true });

const posix = process.platform !== "win32";
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
    expect(merged.locked).toEqual(["api_url", "replicas", "redact", "redact_extra_rules"]);
    expect(merged.diagnostics.filter((line) => line.startsWith("Ignored api_url"))).toEqual([
      "Ignored api_url from env because the managed config locks it.",
      "Ignored api_url from harness because the managed config locks it.",
      "Ignored api_url from root because the managed config locks it.",
      "Ignored api_url from userRoot because the managed config locks it.",
    ]);
    expect(merged.diagnostics).toHaveLength(4 * 4);
  });

  it("locks replicas to none when only the endpoint is locked", () => {
    const path = managedFile({ api_url: locked.api_url });
    const managed = readManagedConfigFile({ path, ownerUid: uid });
    const merged = mergeCommonConfig({ managed, env: override });
    expect(merged).toMatchObject({ api_url: locked.api_url, replicas: [] });
    expect(merged.locked).toEqual(["api_url", "replicas"]);
  });

  it("ignores and reports keys that cannot be locked", () => {
    const path = managedFile({ api_key: 7, enabled: null, apiUrl: "x", redact: true });
    const managed = readManagedConfigFile({ path, ownerUid: uid });
    const merged = mergeCommonConfig({ managed, env: { api_key: "user-key", enabled: true } });
    expect(merged).toMatchObject({ api_key: "user-key", enabled: true, locked: ["redact"] });
    expect(merged.diagnostics).toEqual([expect.stringMatching(/^Ignored keys in managed config/)]);
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
    expect(merged.diagnostics[0]).toMatch(/not owned by root/);
  });

  it.each(["{", "null", '{"api_url":5}'])("turns tracing off for broken file %s", (text) => {
    const managed = readManagedConfigFile({ path: managedFile(text), ownerUid: uid });
    const merged = mergeCommonConfig({ managed, env: { ...override, enabled: true } });
    expect(merged).toMatchObject({ enabled: false, locked: [] });
    expect(merged.diagnostics).toEqual([expect.stringMatching(/unreadable or invalid/)]);
  });

  it.skipIf(uid === 0)("turns tracing off for a file it cannot open", () => {
    const path = managedFile(locked);
    fs.chmodSync(path, 0o000);
    const merged = mergeCommonConfig({
      managed: readManagedConfigFile({ path, ownerUid: uid }),
      env: { enabled: true },
    });
    expect(merged).toMatchObject({ enabled: false, locked: [] });
    expect(merged.diagnostics).toEqual([expect.stringMatching(/unreadable or invalid/)]);
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

  it("uses the home it was given when the account lookup fails", () => {
    vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
      throw new Error("no account");
    });
    const managed = readManagedConfigFile({ ownerUid: uid }, homeWith(locked));
    expect(managed.common.api_url).toBe(locked.api_url);
  });

  it("reads the file it checked even if it is swapped right after opening", () => {
    const path = managedFile(locked);
    const swap = join(path, "..", "swap.json");
    fs.writeFileSync(swap, JSON.stringify({ api_url: "https://attacker.example" }));
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
    expect(mergeCommonConfig({ managed, env: { enabled: true } })).toMatchObject({
      enabled: true,
      locked: [],
      diagnostics: [],
    });
  });
});

it("refuses to merge without the managed file result", () => {
  expect(() =>
    // @ts-expect-error
    mergeCommonConfig({ env: {} }),
  ).toThrow(TypeError);
});
