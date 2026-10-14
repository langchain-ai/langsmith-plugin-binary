import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCaptureStore } from "./capture-store.js";
import { CAPTURE_MARKER_INVALID_WARNING } from "./constants.js";
import { removeExpiredCaptures } from "./expiry.js";
import type { CaptureInput } from "./models.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const input = (eventId: string, extra: Partial<CaptureInput> = {}) => ({
  integration: "claude-code",
  sessionId: "session",
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
const filesBelow = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesBelow(join(directory, entry.name)) : [join(directory, entry.name)],
  );
const markersIn = (root: string) => filesBelow(root).filter((path) => path.endsWith(".outcome"));
const freshStore = () => {
  const root = mkdtempSync(join(tmpdir(), "plugins-base-markers-"));
  return { root, store: createCaptureStore(root) };
};
const deliver = (store: ReturnType<typeof createCaptureStore>, eventId: string) =>
  store.recordOutcome({ ...input(eventId), destination: "a", outcome: "delivered" });

it("leaves no marker when a delivered record is removed on its own", async () => {
  const { root, store } = freshStore();
  await store.capture(input("sent"));
  await deliver(store, "sent");
  await store.remove(input("sent"));
  expect(markersIn(root)).toEqual([]);
  await expect(store.readOutcome(input("sent"), "a")).resolves.toEqual({
    status: "missing-capture",
  });
});

it("leaves one marker for a whole removed turn, so a late dependent sees the delivery", async () => {
  const { root, store } = freshStore();
  const records = [];
  for (const id of ["one", "two", "three"]) {
    await store.capture(input(id));
    await deliver(store, id);
    records.push((await store.read(input(id)))!);
  }
  await store.removeTurn(records);
  expect(markersIn(root)).toHaveLength(1);
  for (const id of ["one", "two", "three"])
    await expect(store.readOutcome(input(id), "a")).resolves.toMatchObject({
      status: "settled",
      receipt: { outcome: "delivered" },
    });
  await expect(store.readDroppedRunIds("claude-code", "session", "turn")).resolves.toEqual(
    new Set(),
  );
  await store.removeStaleMarkers("claude-code", Date.now() + DAY_MS);
  expect(markersIn(root)).toEqual([]);
});

it("lists the runs whose work was dropped", async () => {
  const { store } = freshStore();
  await store.capture(input("lost"));
  await store.recordOutcome({ ...input("lost"), destination: "a", outcome: "dropped" });
  await store.remove(input("lost"));
  await expect(store.readDroppedRunIds("claude-code", "session", "turn")).resolves.toEqual(
    new Set(["run-lost"]),
  );
});

it("removes a marker that cannot be read and treats the parent as unknown", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { root, store } = freshStore();
  await store.capture(input("lost"));
  await store.remove(input("lost"));
  writeFileSync(markersIn(root)[0]!, "{", { mode: 0o600 });
  await expect(store.readOutcome(input("lost"), "a")).resolves.toEqual({
    status: "missing-capture",
  });
  expect(warn).toHaveBeenCalledWith(
    CAPTURE_MARKER_INVALID_WARNING,
    expect.stringMatching(/\.outcome$/),
  );
  expect(markersIn(root)).toEqual([]);
  warn.mockRestore();
});

it("keeps a fresh marker through an expiry pass and removes it once it is a day old", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { root, store } = freshStore();
  await store.capture(input("lost"));
  await store.remove(input("lost"));
  const options = { store, integration: "claude-code", destinations: ["a"], maxAgeMs: DAY_MS };
  await removeExpiredCaptures({ ...options, now: Date.now() });
  expect(markersIn(root)).toHaveLength(1);
  expect(readFileSync(markersIn(root)[0]!, "utf8")).toContain("run-lost");
  await removeExpiredCaptures({ ...options, now: Date.now() + 2 * DAY_MS });
  expect(markersIn(root)).toEqual([]);
  warn.mockRestore();
});

it("keeps what the settled turn learned, and merges late runs into the same marker", async () => {
  const { root, store } = freshStore();
  await store.capture(input("root"));
  await deliver(store, "root");
  const settled = { rootRunId: "run-root", attribution: { repository_name: "acme/project" } };
  await store.removeTurn([(await store.read(input("root")))!], settled);
  await expect(store.readSettledTurn("claude-code", "session", "turn")).resolves.toEqual(settled);
  await store.capture(input("late"));
  await deliver(store, "late");
  await store.removeTurn([(await store.read(input("late")))!]);
  expect(markersIn(root)).toHaveLength(1);
  await expect(store.readSettledTurn("claude-code", "session", "turn")).resolves.toEqual(settled);
  await expect(store.readOutcome(input("late"), "a")).resolves.toMatchObject({
    status: "settled",
  });
  await expect(store.readOutcome(input("root"), "a")).resolves.toMatchObject({
    status: "settled",
  });
});
