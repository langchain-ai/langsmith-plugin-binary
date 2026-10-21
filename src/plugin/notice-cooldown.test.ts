import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { temporaryFolder } from "../test-support/login.js";
import { shouldShowNotice } from "./notice-cooldown.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-21T12:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("notice cooldown", () => {
  it("shows a notice once per two-minute default window and again after it", async () => {
    const storageRoot = temporaryFolder("notice root ");
    const expired = { plugin: "claude-code", kind: "login-expired", storageRoot };
    expect(await shouldShowNotice(expired)).toBe(true);
    expect(await shouldShowNotice(expired)).toBe(false);
    expect(await shouldShowNotice({ ...expired, kind: "managed-invalid" })).toBe(true);
    expect(await shouldShowNotice({ ...expired, plugin: "codex" })).toBe(true);
    vi.advanceTimersByTime(3 * 60 * 1000);
    expect(await shouldShowNotice(expired)).toBe(true);
  });

  it("silences every notice when the cooldown is off", async () => {
    const notice = { plugin: "codex", kind: "login-expired", cooldown: "off" as const };
    expect(
      await shouldShowNotice({ ...notice, storageRoot: temporaryFolder("notice root ") }),
    ).toBe(false);
  });

  it("falls back to once per process when the storage folder can't be used", async () => {
    const storageRoot = join(temporaryFolder("notice blocked "), "root");
    writeFileSync(storageRoot, "");
    const notice = { plugin: "cursor", kind: "login-expired", cooldown: 5, storageRoot };
    expect(await shouldShowNotice(notice)).toBe(true);
    expect(await shouldShowNotice(notice)).toBe(false);
  });
});
