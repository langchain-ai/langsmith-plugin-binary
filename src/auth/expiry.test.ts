import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryFolder, writeLoginConfig } from "../test-support/login.js";
import { readLoginNotice } from "./index.js";
import type { UploadLogin } from "./models.js";
import { expiredMarkerPrefix, loginTokenHash } from "./profile.js";
import {
  clearLoginExpiry,
  clearRejectedKey,
  recordExpiredLogin,
  recordRejectedKey,
} from "./expiry.js";
import { LOGIN_CLEANUP_WARNING } from "./expiry-constants.js";

const API_URL = "https://login.example";
const STATE_ROOT = temporaryFolder("login state ");
const REJECTED = { apiKey: "synthetic-rejected", apiUrl: API_URL };
const STUCK = { apiKey: "synthetic-stuck-key", apiUrl: API_URL };

function login(token: string, configPath?: string) {
  const path = writeLoginConfig(profileWith(token), configPath);
  return { configPath: path, profile: "work" };
}

function expire(rejected: UploadLogin, storageRoot: string | undefined = STATE_ROOT) {
  return recordExpiredLogin(rejected, loginTokenHash(rejected), storageRoot);
}

function profileWith(access_token: string) {
  return { api_url: API_URL, oauth: { access_token } };
}

function hashFor(access_token: string, refresh_token: string) {
  const configPath = writeLoginConfig({ api_url: API_URL, oauth: { access_token, refresh_token } });
  return loginTokenHash({ configPath, profile: "work" });
}

function claims(owner: UploadLogin): string[] {
  const saved = JSON.parse(readFileSync(join(STATE_ROOT, "sign-in.json"), "utf8")) as object;
  return Object.keys(saved).filter((key) => key.startsWith(expiredMarkerPrefix(owner)));
}

function noticeFor(env: NodeJS.ProcessEnv): string | undefined {
  return readLoginNotice(STATE_ROOT, env);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("expired login", () => {
  it("pauses with the sign-in message once per expired login", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const expired = login("synthetic-once");
    expect(await expire(expired)).toBe("notice");
    expect(await expire(expired)).toBe("already-handled");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(noticeFor({ LANGSMITH_CONFIG_FILE: expired.configPath })).toBe(
      [
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "⚠️  LANGSMITH TRACING IS PAUSED",
        "Your LangSmith login expired so this session isn't being traced.",
        "▶ Run the following command: langsmith auth login",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      ].join("\n"),
    );
  });

  it("tells the user to replace a rejected key or sign in instead", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storageRoot = temporaryFolder("rejected key ");
    await recordRejectedKey(REJECTED, storageRoot);
    expect(readLoginNotice(storageRoot, {}, REJECTED)).toBe(
      [
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "⚠️  LANGSMITH TRACING IS PAUSED",
        "Your LangSmith API key was rejected so this session isn't being traced.",
        "▶ Replace the key, or remove it and run: langsmith auth login",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      ].join("\n"),
    );
  });

  it("pauses once per process and still says to sign in without a storage folder", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const homeless = login("synthetic-no-state");
    expect(await expire(homeless, undefined)).toBe("notice");
    expect(await expire(homeless, undefined)).toBe("already-handled");
    expect(noticeFor({ LANGSMITH_CONFIG_FILE: homeless.configPath })).toContain("login expired");
  });

  it("still pauses when a file sits where the storage folder belongs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const blocked = join(temporaryFolder("blocked state "), "root");
    writeFileSync(blocked, "");
    expect(await expire(login("synthetic-blocked"), blocked)).toBe("notice");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("langsmith auth login"));
  });

  it("still pauses when the expired login can't be recorded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const readOnly = temporaryFolder("read only state ");
    chmodSync(readOnly, 0o555);
    expect(await expire(login("synthetic-read-only"), readOnly)).toBe("notice");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("langsmith auth login"));
  });

  it("warns instead of rejecting when read-only state stops a marker being cleared", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storageRoot = temporaryFolder("stuck state ");
    const stuck = login("synthetic-stuck");
    await recordRejectedKey(STUCK, storageRoot);
    await expire(stuck, storageRoot);
    chmodSync(storageRoot, 0o555);
    await expect(clearRejectedKey(storageRoot, STUCK)).resolves.toBeUndefined();
    await expect(clearLoginExpiry(stuck, storageRoot)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(LOGIN_CLEANUP_WARNING, expect.any(String));
  });

  it("stops pausing once the user signs in again and forgets the old expiry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const expired = login("synthetic-cleaned");
    await expire(expired);
    login("synthetic-cleaned-new", expired.configPath);
    expect(noticeFor({ LANGSMITH_CONFIG_FILE: expired.configPath })).toBeUndefined();
    await expire(expired);
    expect(claims(expired)).toHaveLength(1);
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
    expect(await expire(other)).toBe("notice");
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
