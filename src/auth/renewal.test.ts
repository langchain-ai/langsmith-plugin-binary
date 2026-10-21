import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeTool, temporaryFolder, writeLoginConfig } from "../test-support/login.js";
import { setDesktopLauncherForTests } from "../utils/desktop/notification.js";
import { spawnDetached } from "../utils/process.js";
import { execFileAsync, moduleUrl } from "../test-support/tracing/delivery.js";
import { waitFor } from "../test-support/wait.js";
import { readLoginNotice } from "./index.js";
import type { UploadLogin } from "./models.js";
import type { LoginRenewalOptions } from "./renewal-models.js";
import { expiredMarkerPrefix, loginTokenHash } from "./profile.js";
import { renewRejectedLogin } from "./renewal.js";
import { LOGIN_NOTICE_KIND } from "./renewal-constants.js";
import { shouldShowNotice } from "../plugin/notice-cooldown.js";

const API_URL = "https://login.example";
const STATE_ROOT = temporaryFolder("login state ");
const STATE = join(STATE_ROOT, "sign-in");
const LOGGING_CLI =
  'echo "$@" >> "${0%/*}/calls.log"\necho "Enter code: TEST-CODE" >&2\necho "Waiting for authorization..." >&2';
const WAITING_CLI = `${LOGGING_CLI}\nexec /bin/sleep 60`;

function fakeTools(folder?: string, cli = WAITING_CLI, name = "langsmith") {
  const bin = fakeTool(name, cli, folder);
  fakeTool("notify-send", "", bin);
  return { bin, calls: join(bin, "calls.log") };
}

function login(token: string, configPath?: string) {
  const path = writeLoginConfig(profileWith(token), configPath);
  return { configPath: path, profile: "work" };
}

function renew(rejected: UploadLogin, options: LoginRenewalOptions) {
  const hash = loginTokenHash(rejected)!;
  return renewRejectedLogin(rejected, API_URL, hash, {
    platform: "linux",
    cliFolders: [],
    notify: { plugin: "test", cooldown: 0 },
    storageRoot: STATE_ROOT,
    ...options,
  });
}

function profileWith(access_token: string) {
  return { api_url: API_URL, oauth: { access_token } };
}

function hashFor(access_token: string, refresh_token: string) {
  const configPath = writeLoginConfig({ api_url: API_URL, oauth: { access_token, refresh_token } });
  return loginTokenHash({ configPath, profile: "work" });
}

function markers(owner: UploadLogin): string[] {
  if (!existsSync(STATE)) return [];
  return readdirSync(STATE).filter((name) => name.startsWith(expiredMarkerPrefix(owner)));
}

function claims(owner: UploadLogin): string[] {
  const saved = JSON.parse(readFileSync(join(STATE_ROOT, "sign-in.json"), "utf8")) as object;
  return Object.keys(saved).filter((key) => key.startsWith(expiredMarkerPrefix(owner)));
}

function noticeFor(env: NodeJS.ProcessEnv): string | undefined {
  return readLoginNotice(STATE_ROOT, env);
}

afterEach(() => {
  setDesktopLauncherForTests();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("expired login renewal", () => {
  it("opens the browser sign-in once per expired login and shows its code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bin, calls } = fakeTools();
    const env = { PATH: bin, DISPLAY: ":0" };
    const notices: string[] = [];
    setDesktopLauncherForTests((command, args, ...rest) => {
      if (!command.endsWith("notify-send")) return spawnDetached(command, args, ...rest);
      notices.push(args.join(" "));
      return undefined;
    });
    const first = login("synthetic-expired");
    expect(await renew(first, { env })).toBe("browser");
    expect(await renew(first, { env })).toBe("already-handled");
    expect(readFileSync(calls, "utf8")).toBe(
      `auth login --api-url ${API_URL} --timeout 15m --profile work\n`,
    );
    expect(notices.join("\n")).toContain("Enter code TEST-CODE");
    const pausedFor = { LANGSMITH_CONFIG_FILE: first.configPath };
    expect(noticeFor(pausedFor)).toContain("Enter code TEST-CODE");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000);
    expect(noticeFor(pausedFor)).not.toContain("TEST-CODE");
    vi.mocked(Date.now).mockRestore();
    const second = login("synthetic-renewed-then-expired", first.configPath);
    expect(await renew(second, { env })).toBe("browser");
    expect(markers(first)).toHaveLength(1);
  });

  it("only warns when the browser setting is off or the session has no screen", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bin, calls } = fakeTools();
    const off = login("synthetic-setting-off");
    expect(await renew(off, { browser: false, env: { PATH: bin, DISPLAY: ":0" } })).toBe("notice");
    expect(await renew(off, { browser: false, env: { PATH: bin, DISPLAY: ":0" } })).toBe(
      "already-handled",
    );
    const ssh = login("synthetic-over-ssh");
    const sshEnv = { PATH: bin, DISPLAY: ":0", SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" };
    expect(await renew(ssh, { env: sshEnv })).toBe("notice");
    expect(existsSync(calls)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Run `langsmith auth login`"));
  });

  it("tells the user how to install the CLI only when it is in none of the usual folders", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const empty = temporaryFolder("empty path ");
    const env = { PATH: empty, DISPLAY: ":0" };
    expect(await renew(login("synthetic-no-cli"), { env })).toBe("notice");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cli.langsmith.com/install.sh"));
    const home = temporaryFolder("gui app home ");
    const { calls } = fakeTools(join(home, ".local", "bin"));
    const offPath = login("synthetic-cli-off-path");
    expect(
      await renewRejectedLogin(offPath, API_URL, loginTokenHash(offPath)!, {
        env: { ...env, HOME: home },
        platform: "linux",
        storageRoot: STATE_ROOT,
      }),
    ).toBe("browser");
    await waitFor(() => existsSync(calls), "the CLI in ~/.local/bin");
    const appData = temporaryFolder("local app data ");
    const windowsCli = fakeTools(
      join(appData, "Programs", "langsmith", "bin"),
      WAITING_CLI,
      "langsmith.exe",
    );
    const windows = login("synthetic-windows-cli");
    const windowsEnv = { PATH: "", PATHEXT: ".exe", LOCALAPPDATA: appData };
    const windowsHash = loginTokenHash(windows)!;
    expect(
      await renewRejectedLogin(windows, API_URL, windowsHash, {
        env: windowsEnv,
        platform: "win32",
        storageRoot: STATE_ROOT,
      }),
    ).toBe("browser");
    await waitFor(() => existsSync(windowsCli.calls), "the CLI in LocalAppData");
    expect(await renew(login("synthetic-no-windows-cli"), { env: {}, platform: "win32" })).toBe(
      "notice",
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("install.ps1 | iex"));
  });

  it("lets only one of many uploaders start the sign-in", async () => {
    const { bin } = fakeTools();
    const expired = login("synthetic-racing");
    const log = join(temporaryFolder("race log "), "launches.log");
    const startAt = String(Date.now() + 1500);
    const worker = fileURLToPath(new URL("./fixtures/renew-worker.mjs", import.meta.url));
    const urls = [
      moduleUrl("dist/auth/renewal.js"),
      moduleUrl("dist/utils/desktop/notification.js"),
    ];
    const hash = loginTokenHash(expired)!;
    const args = [worker, ...urls, expired.configPath, log, startAt, bin, hash, STATE_ROOT];
    await Promise.all(Array.from({ length: 20 }, () => execFileAsync(process.execPath, args)));
    const launches = readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.endsWith("langsmith"));
    expect(launches).toHaveLength(1);
  });

  it("never crashes the uploader when the sign-in can't start", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bin } = fakeTools();
    setDesktopLauncherForTests(() => {
      throw new Error("spawn failed");
    });
    await expect(
      renew(login("synthetic-spawn-throws"), { env: { PATH: bin, DISPLAY: ":0" } }),
    ).resolves.toBe("notice");
  });

  it("notifies once and doesn't retry when the CLI can't start", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bin } = fakeTools();
    const stuck = login("synthetic-cli-broken");
    const launched: string[] = [];
    setDesktopLauncherForTests((command) => {
      launched.push(command);
      return undefined;
    });
    expect(await renew(stuck, { env: { PATH: bin, DISPLAY: ":0" } })).toBe("notice");
    expect(await renew(stuck, { env: { PATH: bin, DISPLAY: ":0" } })).toBe("already-handled");
    expect(launched.filter((command) => command.endsWith("notify-send"))).toHaveLength(1);
  });

  it("notifies once per process and still says to sign in without a storage folder", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bin } = fakeTools();
    const homeless = login("synthetic-no-state");
    const notified: string[] = [];
    setDesktopLauncherForTests((command) => {
      notified.push(command);
      return undefined;
    });
    for (const expected of ["notice", "already-handled"])
      expect(await renew(homeless, { env: { PATH: bin }, storageRoot: undefined })).toBe(expected);
    expect(notified).toHaveLength(1);
    expect(noticeFor({ LANGSMITH_CONFIG_FILE: homeless.configPath })).toContain("token expired");
  });

  it("warns instead of skipping when a file sits where the storage folder belongs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bin } = fakeTools();
    const blocked = join(temporaryFolder("blocked state "), "root");
    writeFileSync(blocked, "");
    const env = { PATH: bin, DISPLAY: ":0" };
    expect(await renew(login("synthetic-blocked"), { env, storageRoot: blocked })).toBe("notice");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Run `langsmith auth login`"));
  });

  it("shows the code only while the CLI is still waiting, in either wording", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bin } = fakeTools();
    const output = {
      waiting:
        "Check that the page shows this code, or enter it: ABCD-1234\nWaiting for authorization...\n",
      ended:
        "Enter code: DEAD-CODE\nWaiting for authorization...\ntimed out waiting for authorization\n",
    };
    for (const [state, text] of Object.entries(output)) {
      setDesktopLauncherForTests((_command, _args, _env, descriptor) => {
        if (descriptor !== undefined) writeSync(descriptor, text);
        return 1;
      });
      const expired = login(`synthetic-${state}`);
      await renew(expired, { env: { PATH: bin, DISPLAY: ":0" } });
      const notice = noticeFor({ LANGSMITH_CONFIG_FILE: expired.configPath });
      expect(notice?.includes("ABCD-1234") || notice?.includes("DEAD-CODE")).toBe(
        state === "waiting",
      );
    }
  });

  it("shows a desktop notification only when the plugin asks for one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bin } = fakeTools();
    const launched: string[] = [];
    setDesktopLauncherForTests((command) => {
      launched.push(command);
      return 1;
    });
    expect(
      await renew(login("synthetic-quiet"), {
        browser: false,
        notify: undefined,
        env: { PATH: bin },
      }),
    ).toBe("notice");
    expect(launched).toEqual([]);
  });

  it("lets plugin tests replace the browser launcher and notifier", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const launched: string[] = [];
    setDesktopLauncherForTests((command, _args, _env, output) => {
      launched.push(command);
      if (output !== undefined) writeSync(output, "Enter code: TEST-CODE\n");
      return 1;
    });
    const { bin, calls } = fakeTools();
    const hooked = login("synthetic-hooked");
    const env = { PATH: bin, HOME: STATE_ROOT };
    expect(await renew(hooked, { env, platform: "darwin" })).toBe("browser");
    expect(launched).toEqual([join(bin, "langsmith"), "/usr/bin/osascript"]);
    expect(existsSync(calls)).toBe(false);
  });

  it("still warns when the expired login can't be recorded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bin, calls } = fakeTools();
    const locked = login("synthetic-read-only");
    const readOnly = temporaryFolder("read only state ");
    chmodSync(readOnly, 0o555);
    const env = { PATH: bin, DISPLAY: ":0" };
    expect(await renew(locked, { env, storageRoot: readOnly })).toBe("notice");
    expect(existsSync(calls)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Run `langsmith auth login`"));
  });

  it("forgets an old login's expiry once the next one is claimed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const expired = login("synthetic-cleaned");
    await renew(expired, { browser: false });
    login("synthetic-cleaned-new", expired.configPath);
    expect(noticeFor({ LANGSMITH_CONFIG_FILE: expired.configPath })).toBeUndefined();
    await renew(expired, { browser: false });
    expect(claims(expired)).toHaveLength(1);
  });

  it("puts its own notice through the plugin's cooldown, and off silences it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const launched: string[] = [];
    setDesktopLauncherForTests((command) => {
      launched.push(command);
      return 1;
    });
    const storageRoot = temporaryFolder("cooldown root ");
    const notify = { plugin: "cursor", cooldown: 5 };
    await renew(login("synthetic-cooled"), {
      browser: false,
      notify,
      storageRoot,
      platform: "darwin",
    });
    expect(launched).toHaveLength(1);
    const plugin = { ...notify, kind: LOGIN_NOTICE_KIND, storageRoot };
    expect(await shouldShowNotice(plugin)).toBe(false);
    const quiet = { plugin: "codex", cooldown: "off" as const };
    await renew(login("synthetic-off"), {
      browser: false,
      notify: quiet,
      storageRoot,
      platform: "darwin",
    });
    expect(launched).toHaveLength(1);
  });

  it("charges the rejection to the profile the upload used, not the current one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const configPath = join(temporaryFolder("two profiles "), "config.json");
    const profiles = {
      work: profileWith("synthetic-work"),
      other: profileWith("synthetic-other"),
      copy: profileWith("synthetic-other"),
    };
    writeFileSync(configPath, JSON.stringify({ current_profile: "work", profiles }));
    const other = { configPath, profile: "other" };
    expect(await renew(other, { browser: false, env: {} })).toBe("notice");
    expect(
      noticeFor({ LANGSMITH_CONFIG_FILE: configPath, LANGSMITH_PROFILE: "other" }),
    ).toBeDefined();
    expect(
      noticeFor({ LANGSMITH_CONFIG_FILE: configPath, LANGSMITH_PROFILE: "copy" }),
    ).toBeUndefined();
  });

  it("treats a refreshed access token as the same login and a new refresh token as a new one", () => {
    expect(hashFor("synthetic-a1", "synthetic-r1")).toBe(hashFor("synthetic-a2", "synthetic-r1"));
    expect(hashFor("synthetic-a1", "synthetic-r1")).not.toBe(
      hashFor("synthetic-a1", "synthetic-r2"),
    );
  });
});
