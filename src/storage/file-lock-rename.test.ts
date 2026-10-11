import { mkdtemp, readFile, readdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { beforeEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ attempts: 0, failures: 0, code: "EPERM" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      fault.attempts += 1;
      if (fault.failures > 0) {
        fault.failures -= 1;
        const previous = JSON.parse(await actual.readFile(args[1], "utf8"));
        expect(previous.choosing).toBe(true);
        throw Object.assign(new Error("injected rename failure"), { code: fault.code });
      }
      return actual.rename(...args);
    },
  };
});

import { tryAcquireFileLock, withFileLock } from "./file-lock.js";

beforeEach(() => {
  fault.attempts = 0;
  fault.failures = 1;
  fault.code = "EPERM";
});

it("retries a sharing violation without removing the published claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lock-rename-retry-"));
  const path = join(directory, "state.lock");
  const claims = `${path}.claims`;
  const callback = vi.fn(async () => {
    const entries = await readdir(claims);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error("Missing published claim");
    expect(JSON.parse(await readFile(join(claims, entry), "utf8"))).toMatchObject({
      choosing: false,
      ticket: 1,
    });
  });
  try {
    await withFileLock(path, callback, { timeoutMs: 1000 });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(fault.attempts).toBe(2);
    expect(await readdir(claims)).toEqual([]);
  } finally {
    await rmdir(claims);
    await rmdir(directory);
  }
});

it("bounds persistent sharing failures by the acquisition deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lock-rename-timeout-"));
  const path = join(directory, "state.lock");
  const callback = vi.fn();
  fault.failures = Infinity;
  const started = performance.now();
  try {
    await expect(withFileLock(path, callback, { timeoutMs: 300 })).rejects.toThrow("Timed out");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    expect(fault.attempts).toBeGreaterThan(1);
    expect(callback).not.toHaveBeenCalled();
    expect(await readdir(`${path}.claims`)).toEqual([]);
  } finally {
    await rmdir(`${path}.claims`);
    await rmdir(directory);
  }
});

it("bounds sharing retries when acquiring without waiting for peers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lock-rename-try-"));
  const path = join(directory, "state.lock");
  fault.failures = Infinity;
  const started = performance.now();
  try {
    await expect(tryAcquireFileLock(path)).rejects.toThrow("Timed out");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(fault.attempts).toBeGreaterThan(1);
    expect(await readdir(`${path}.claims`)).toEqual([]);
  } finally {
    await rmdir(`${path}.claims`);
    await rmdir(directory);
  }
});

it("does not retry unrelated filesystem failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lock-rename-error-"));
  const path = join(directory, "state.lock");
  const callback = vi.fn();
  fault.code = "EIO";
  try {
    await expect(withFileLock(path, callback)).rejects.toMatchObject({ code: "EIO" });
    expect(fault.attempts).toBe(1);
    expect(callback).not.toHaveBeenCalled();
    expect(await readdir(`${path}.claims`)).toEqual([]);
  } finally {
    await rmdir(`${path}.claims`);
    await rmdir(directory);
  }
});
