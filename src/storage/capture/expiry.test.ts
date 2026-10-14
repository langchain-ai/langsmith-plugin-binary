import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCaptureStore } from "./capture-store.js";
import { removeExpiredCaptures } from "./expiry.js";
import type { CaptureInput } from "./models.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const filesBelow = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesBelow(join(directory, entry.name)) : [join(directory, entry.name)],
  );
const input = (sessionId: string, eventId: string, extra: Partial<CaptureInput> = {}) => ({
  integration: "claude-code",
  sessionId,
  turnId: "turn",
  eventId,
  runId: `run-${eventId}`,
  destinationFingerprint: "account",
  eventKind: "run-post",
  normalizedPayload: {},
  turnEvidence: {},
  metadataProvenance: {},
  ...extra,
});

it("removes events past the age limit in every session and warns once for the undelivered ones", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const store = createCaptureStore(mkdtempSync(join(tmpdir(), "plugins-base-expiry-")));
  const old = Date.now() - 2 * DAY_MS;
  await store.capture(input("one", "stuck", { sourceAgeStartedAtMs: old }));
  await store.capture(input("two", "partial", { sourceAgeStartedAtMs: old }));
  await store.capture(input("two", "sent", { sourceAgeStartedAtMs: old }));
  await store.capture(input("two", "young"));
  await store.recordOutcome({ ...input("two", "partial"), destination: "a", outcome: "delivered" });
  for (const destination of ["a", "b"])
    await store.recordOutcome({ ...input("two", "sent"), destination, outcome: "delivered" });
  const dropped = await removeExpiredCaptures({
    store,
    integration: "claude-code",
    destinations: ["a", "b"],
    now: Date.now(),
    maxAgeMs: DAY_MS,
  });
  expect(dropped).toBe(2);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("2 saved items");
  expect(
    (await store.enumerateSessions("claude-code")).flatMap(({ captures }) =>
      captures.map(({ record }) => record.eventId),
    ),
  ).toEqual(["young"]);
  warn.mockRestore();
});

it("falls back to the capture time when the source start is unknown", async () => {
  const store = createCaptureStore(mkdtempSync(join(tmpdir(), "plugins-base-expiry-")));
  await store.capture(input("one", "fresh"));
  const options = { store, integration: "claude-code", destinations: ["a"], maxAgeMs: DAY_MS };
  await expect(removeExpiredCaptures({ ...options, now: Date.now() })).resolves.toBe(0);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await expect(removeExpiredCaptures({ ...options, now: Date.now() + 2 * DAY_MS })).resolves.toBe(
    1,
  );
  warn.mockRestore();
});

it("keeps a live start while the same turn still has recent captures", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const store = createCaptureStore(mkdtempSync(join(tmpdir(), "plugins-base-expiry-")));
    await store.capture(input("one", "start"));
    await store.recordOutcome({ ...input("one", "start"), destination: "a", outcome: "delivered" });
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    await store.capture(input("one", "end"));
    await removeExpiredCaptures({
      store,
      integration: "claude-code",
      destinations: ["a"],
      now: Date.now(),
      maxAgeMs: DAY_MS,
    });
    const kept = (await store.enumerateSessions("claude-code")).flatMap(({ captures }) =>
      captures.map(({ record }) => record.eventId),
    );
    expect(kept.toSorted()).toEqual(["end", "start"]);
  } finally {
    vi.useRealTimers();
  }
});

it("names a changed upload setting when it drops work that could never be sent", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const store = createCaptureStore(mkdtempSync(join(tmpdir(), "plugins-base-expiry-")));
  await store.capture(input("one", "stuck", { sourceAgeStartedAtMs: Date.now() - 2 * DAY_MS }));
  await removeExpiredCaptures({
    store,
    integration: "claude-code",
    destinations: ["a"],
    accountFingerprint: "another-account",
    now: Date.now(),
    maxAgeMs: DAY_MS,
  });
  expect(String(warn.mock.calls[0]?.[0])).toContain("1 saved under a different API key");
  warn.mockRestore();
});

it("drops a turn that kept capturing past the hard ceiling and says so once", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const store = createCaptureStore(mkdtempSync(join(tmpdir(), "plugins-base-expiry-")));
    await store.capture(input("one", "first"));
    for (let day = 1; day <= 8; day += 1) {
      vi.setSystemTime(Date.now() + DAY_MS / 2);
      await store.capture(input("one", `later-${day}`));
    }
    const dropped = await removeExpiredCaptures({
      store,
      integration: "claude-code",
      destinations: ["a"],
      now: Date.now() + 3 * DAY_MS,
      maxAgeMs: 10 * DAY_MS,
    });
    expect(dropped).toBe(9);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("9 from turns that kept capturing");
  } finally {
    vi.useRealTimers();
    warn.mockRestore();
  }
});

it("keeps a content-free marker for removed undelivered work until it is a day old", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugins-base-expiry-"));
  const store = createCaptureStore(root);
  await store.capture(input("one", "stuck", { normalizedPayload: { secret: "PRIVATE-TEXT" } }));
  await store.capture(input("one", "kept"));
  await store.remove(input("one", "stuck"));
  await expect(store.readOutcome(input("one", "stuck"), "a")).resolves.toMatchObject({
    status: "settled",
    receipt: { outcome: "dropped" },
  });
  const markers = filesBelow(root).filter((path) => path.endsWith(".outcome"));
  expect(markers).toHaveLength(1);
  expect(readFileSync(markers[0]!, "utf8")).not.toContain("PRIVATE-TEXT");
  await store.removeStaleMarkers("claude-code", Date.now() - DAY_MS);
  expect(filesBelow(root).filter((path) => path.endsWith(".outcome"))).toHaveLength(1);
  await store.removeStaleMarkers("claude-code", Date.now() + DAY_MS);
  expect(filesBelow(root).filter((path) => path.endsWith(".outcome"))).toHaveLength(0);
  await expect(store.readOutcome(input("one", "stuck"), "a")).resolves.toEqual({
    status: "missing-capture",
  });
});

it("forgets a turn's markers when the turn itself is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugins-base-expiry-"));
  const store = createCaptureStore(root);
  await store.capture(input("one", "stuck"));
  await store.capture(input("one", "other"));
  await store.remove(input("one", "stuck"));
  await store.remove(input("one", "other"), { forgetTurn: true });
  expect(filesBelow(root)).toEqual([]);
});
