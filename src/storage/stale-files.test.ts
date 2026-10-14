import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { removeStaleStorageFiles } from "./stale-files.js";

const HOUR_MS = 60 * 60 * 1000;
const eventName = `${"a".repeat(64)}.json`;

function age(path: string, hours: number): void {
  const at = new Date(Date.now() - hours * HOUR_MS);
  utimesSync(path, at, at);
}

const uuid = (digit: string) => `${digit.repeat(8)}-0000-4000-8000-000000000000`;
const FOLDERS = ["capture-v1", "background-worker"];
const sweep = (root: string) => removeStaleStorageFiles(root, FOLDERS, Date.now() - 2 * HOUR_MS);

it("removes only the engine's own old leftovers and keeps events, recent files and everything else", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const root = mkdtempSync(join(tmpdir(), "plugins-base-stale-"));
  const events = join(root, "capture-v1", "turns", "events");
  const claims = join(root, "capture-v1", "locks", "state.lock.claims");
  const workers = join(root, "background-worker");
  mkdirSync(events, { recursive: true });
  mkdirSync(claims, { recursive: true });
  mkdirSync(workers);
  mkdirSync(join(root, "other-plugin"));
  const stale = [
    join(events, `.${uuid("b")}.tmp`),
    join(claims, `${uuid("c")}.json`),
    join(workers, `wake.active.${uuid("d")}.json`),
    join(workers, `wake.active.${uuid("d")}.attempt.2.json`),
    join(workers, "wake.launching"),
  ];
  const kept = [
    join(events, eventName),
    join(workers, "wake.pending"),
    join(claims, "notes.json"),
    join(root, "settings.json"),
    join(root, "other-plugin", "state.json"),
    join(workers, "readme.txt"),
    join(workers, `${uuid("a")}.json`),
  ];
  for (const path of [...kept, ...stale]) writeFileSync(path, "{}");
  for (const path of [...kept, ...stale]) age(path, 3);
  age(claims, 3);
  mkdirSync(join(workers, "old-empty"));
  age(join(workers, "old-empty"), 3);
  mkdirSync(join(workers, "new-empty"));
  mkdirSync(join(root, "other-empty"));
  age(join(root, "other-empty"), 3);
  const outside = mkdtempSync(join(tmpdir(), "plugins-base-outside-"));
  writeFileSync(join(outside, `.${uuid("e")}.tmp`), "{}");
  age(join(outside, `.${uuid("e")}.tmp`), 3);
  symlinkSync(outside, join(workers, "link-to-outside"));
  await expect(sweep(root)).resolves.toBe(5);
  expect(kept.every(existsSync)).toBe(true);
  expect(stale.some(existsSync)).toBe(false);
  expect(existsSync(join(workers, "old-empty"))).toBe(false);
  expect(existsSync(join(workers, "new-empty"))).toBe(true);
  expect(existsSync(join(root, "other-empty"))).toBe(true);
  expect(existsSync(join(outside, `.${uuid("e")}.tmp`))).toBe(true);
  expect(warn).toHaveBeenCalledTimes(5);
  warn.mockRestore();
});

it("removes a whole chain of old empty folders in one pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugins-base-stale-"));
  const deepest = join(root, "capture-v1", "a", "b");
  mkdirSync(deepest, { recursive: true });
  const file = join(deepest, `.${uuid("f")}.tmp`);
  writeFileSync(file, "{}");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  for (const path of [file, deepest, join(root, "capture-v1", "a")]) age(path, 3);
  await sweep(root);
  expect(existsSync(join(root, "capture-v1", "a"))).toBe(false);
  vi.restoreAllMocks();
});

it("does nothing when the folders do not exist", async () => {
  await expect(sweep(join(tmpdir(), "plugins-base-missing-root"))).resolves.toBe(0);
});

it("removes old delivery receipts and attempt files left by the previous layout", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const root = mkdtempSync(join(tmpdir(), "plugins-base-stale-legacy-"));
  const receipts = join(root, "capture-v1", "turn", "receipts", "b".repeat(64));
  const attempts = join(root, "delivery-v1", "event", "destinations", "d", "attempts");
  mkdirSync(receipts, { recursive: true });
  mkdirSync(attempts, { recursive: true });
  const legacy = [join(receipts, eventName), join(attempts, "1.json"), join(attempts, "2.json")];
  const keep = join(attempts, "notes.json");
  for (const path of [...legacy, keep]) {
    writeFileSync(path, "{}");
    age(path, 3);
  }
  await removeStaleStorageFiles(root, ["capture-v1", "delivery-v1"], Date.now() - 2 * HOUR_MS);
  expect(legacy.some(existsSync)).toBe(false);
  expect(existsSync(keep)).toBe(true);
  warn.mockRestore();
});
