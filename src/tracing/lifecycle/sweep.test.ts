import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { LocalEndpoint } from "../../test-support/models/lifecycle.js";
import { filesUnder, temporaryRoot } from "../../test-support/tracing/delivery.js";
import {
  localEndpoint,
  runPost,
  turnEvidence,
  writerFor,
} from "../../test-support/tracing/lifecycle.js";
import { createLifecycleBridge } from "./index.js";

const failures = vi.hoisted(() => ({ expiry: false, stale: false }));

vi.mock("../../storage/capture/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../storage/capture/index.js")>();
  return {
    ...original,
    removeExpiredCaptures: (...input: Parameters<typeof original.removeExpiredCaptures>) => {
      if (failures.expiry) throw new Error("synthetic expiry failure");
      return original.removeExpiredCaptures(...input);
    },
  };
});

vi.mock("../../storage/stale-files.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../storage/stale-files.js")>();
  return {
    ...original,
    removeStaleStorageFiles: (...input: Parameters<typeof original.removeStaleStorageFiles>) => {
      if (failures.stale) throw new Error("synthetic sweep failure");
      return original.removeStaleStorageFiles(...input);
    },
  };
});

let endpoint: LocalEndpoint;
let root: string;
let warn: MockInstance<typeof console.warn>;

beforeEach(async () => {
  failures.expiry = false;
  failures.stale = false;
  endpoint = await localEndpoint();
  root = temporaryRoot();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  warn.mockRestore();
  await endpoint.close();
});

function lifecycle() {
  return createLifecycleBridge({
    storageRoot: root,
    integration: "claude-code",
    sessionId: "session-1",
    writer: writerFor(endpoint.url),
    policy: { retryBaseMs: 0, quickRetryMs: 0 },
  });
}

function strayFile() {
  const stray = join(
    root,
    "background-worker",
    "wake.active.11111111-0000-4000-8000-000000000000.json",
  );
  mkdirSync(join(root, "background-worker"));
  writeFileSync(stray, "{}");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(stray, old, old);
}

const saveOld = () =>
  lifecycle().capture({
    turnId: "turn",
    eventId: "old",
    submission: runPost("root"),
    turnEvidence: turnEvidence("open", []),
    sourceAgeStartedAtMs: Date.now() - 25 * 60 * 60 * 1000,
  });

it("still clears old leftover files when the expiry sweep fails", async () => {
  strayFile();
  await saveOld();
  failures.expiry = true;
  await expect(lifecycle().drain()).resolves.toMatchObject({ status: "drained" });
  expect(filesUnder(root).some((file) => file.includes("wake.active.11111111"))).toBe(false);
  expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
    "synthetic expiry failure",
  );
});

it("still drops expired work when the leftover-file sweep fails", async () => {
  strayFile();
  await saveOld();
  failures.stale = true;
  await expect(lifecycle().drain()).resolves.toMatchObject({ dropped: 1 });
  expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
    "synthetic sweep failure",
  );
});

it("names a changed upload setting when it drops expired work that could never be sent", async () => {
  await saveOld();
  const changed = createLifecycleBridge({
    storageRoot: root,
    integration: "claude-code",
    sessionId: "session-1",
    writer: { ...writerFor(endpoint.url), redact: true },
    policy: { retryBaseMs: 0, quickRetryMs: 0 },
  });
  await expect(changed.drain()).resolves.toMatchObject({ dropped: 1 });
  expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
    "1 saved under a different API key",
  );
});

it("clears the claim a killed hook left in a record lock folder", async () => {
  const claims = join(root, "record-lock-v1", "events", "abc.lock.claims");
  mkdirSync(claims, { recursive: true });
  const claim = join(claims, "22222222-0000-4000-8000-000000000000.json");
  writeFileSync(claim, "{}");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(claim, old, old);
  await expect(lifecycle().drain()).resolves.toMatchObject({ status: "drained" });
  expect(existsSync(claim)).toBe(false);
});
