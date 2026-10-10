import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { FileLockTimeoutError } from "./index.js";

const faults = vi.hoisted(() => ({
  gatePath: "",
  mkdirCodes: [] as string[],
  mkdirAttempts: 0,
  mkdirFailures: 0,
  rmdirPath: "",
  rmdirCode: "",
  rmdirFailures: 0,
  rmdirAttempts: 0,
  unlinkPath: "",
  unlinkCode: "",
  unlinkFailures: 0,
  unlinkAttempts: 0,
  releaseEvents: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (String(args[0]) === faults.gatePath) {
        faults.mkdirAttempts += 1;
        if (faults.mkdirCodes.length > 0) {
          faults.mkdirFailures += 1;
          const code = faults.mkdirCodes.shift() ?? "EIO";
          throw Object.assign(new Error("Injected lock-directory contention"), { code });
        }
      }
      return actual.mkdir(...args);
    },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      if (String(args[0]) === faults.rmdirPath) {
        faults.rmdirAttempts += 1;
        faults.releaseEvents.push("gate");
        if (faults.rmdirFailures > 0) {
          faults.rmdirFailures -= 1;
          throw Object.assign(new Error("Injected legacy gate cleanup failure"), {
            code: faults.rmdirCode,
          });
        }
      }
      return actual.rmdir(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (String(args[0]) === faults.unlinkPath) {
        faults.unlinkAttempts += 1;
        faults.releaseEvents.push("claim");
        if (faults.unlinkFailures > 0) {
          faults.unlinkFailures -= 1;
          throw Object.assign(new Error("Injected shared claim cleanup failure"), {
            code: faults.unlinkCode,
          });
        }
      }
      return actual.unlink(...args);
    },
  };
});

import {
  acquireCompatibleDirectoryFileLock,
  tryAcquireFileLock,
  withFileLock,
} from "./file-lock.js";

const CLAIM_SUFFIX = ".claims";
const CLAIM_EXTENSION = ".json";

function createArea() {
  const directory = mkdtempSync(join(tmpdir(), "plugins-base-compatible-lock-"));
  const filePath = join(directory, "state.lock");
  return {
    directory,
    filePath,
    gatePath: `${filePath}.lock`,
    claimsPath: `${filePath}${CLAIM_SUFFIX}`,
  };
}

function cleanDirectory(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const name of readdirSync(entryPath)) unlinkSync(join(entryPath, name));
      rmdirSync(entryPath);
    } else {
      unlinkSync(entryPath);
    }
  }
  rmdirSync(directory);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for lock test state");
    await delay(5);
  }
}

function startSharedHolder(filePath: string) {
  const signals: { enter?: () => void; finish?: () => void } = {};
  const entered = new Promise<void>((resolve) => {
    signals.enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    signals.finish = resolve;
  });
  const run = withFileLock(
    filePath,
    async () => {
      signals.enter?.();
      await gate;
    },
    { timeoutMs: 2_000 },
  );
  return { entered, finish: () => signals.finish?.(), run };
}

beforeEach(() => {
  faults.gatePath = "";
  faults.mkdirCodes = [];
  faults.mkdirAttempts = 0;
  faults.mkdirFailures = 0;
  faults.rmdirPath = "";
  faults.rmdirCode = "";
  faults.rmdirFailures = 0;
  faults.rmdirAttempts = 0;
  faults.unlinkPath = "";
  faults.unlinkCode = "";
  faults.unlinkFailures = 0;
  faults.unlinkAttempts = 0;
  faults.releaseEvents = [];
});

it("waits for the old directory gate and holds both locks until an idempotent release", async () => {
  const area = createArea();
  mkdirSync(area.gatePath, { mode: 0o700 });
  const pending = acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 1_000 });
  try {
    await delay(30);
    expect(existsSync(area.claimsPath)).toBe(false);
    rmdirSync(area.gatePath);
    const handle = await pending;
    const claimName = readdirSync(area.claimsPath).find((name) => name.endsWith(CLAIM_EXTENSION));
    expect(claimName).toBeDefined();
    if (!claimName) throw new Error("The compatible lock did not create a shared claim");
    faults.rmdirPath = area.gatePath;
    faults.unlinkPath = join(area.claimsPath, claimName);

    expect(() => mkdirSync(area.gatePath)).toThrow();
    const release = handle.release();
    expect(handle.release()).toBe(release);
    await release;
    expect(faults.releaseEvents).toEqual(["claim", "gate"]);
    expect(existsSync(area.gatePath)).toBe(false);
    const next = await tryAcquireFileLock(area.filePath);
    expect(next).toBeDefined();
    await next?.release();
  } finally {
    cleanDirectory(area.directory);
  }
});

it("keeps a relative lock path stable when the working directory changes while waiting", async () => {
  const originalDirectory = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "plugins-base-relative-lock-"));
  const firstDirectory = join(root, "first");
  const secondDirectory = join(root, "second");
  mkdirSync(firstDirectory);
  mkdirSync(secondDirectory);
  const gatePath = join(firstDirectory, "state.lock.lock");
  mkdirSync(gatePath, { mode: 0o700 });
  process.chdir(firstDirectory);
  const pending = acquireCompatibleDirectoryFileLock("state.lock", { timeoutMs: 1_000 });
  try {
    await delay(30);
    process.chdir(secondDirectory);
    rmdirSync(gatePath);
    const handle = await pending;
    expect(existsSync(join(firstDirectory, "state.lock.claims"))).toBe(true);
    expect(existsSync(join(secondDirectory, "state.lock.claims"))).toBe(false);
    await handle.release();
  } finally {
    process.chdir(originalDirectory);
    cleanDirectory(firstDirectory);
    cleanDirectory(secondDirectory);
    rmdirSync(root);
  }
});

it("does not remove a replacement legacy gate during release", async () => {
  const area = createArea();
  const holder = startSharedHolder(area.filePath);
  await holder.entered;
  const pending = acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 1_000 });
  const originalGatePath = `${area.gatePath}.owned`;
  try {
    await waitFor(() => existsSync(area.gatePath));
    renameSync(area.gatePath, originalGatePath);
    mkdirSync(area.gatePath, { mode: 0o700 });
    holder.finish();
    await holder.run;
    const handle = await pending;
    await expect(handle.release()).rejects.toThrow("Legacy file lock gate changed before release");
    expect(lstatSync(area.gatePath).isDirectory()).toBe(true);
  } finally {
    holder.finish();
    await holder.run;
    cleanDirectory(area.directory);
  }
});

it("leaves an unknown legacy directory in place after timing out", async () => {
  const area = createArea();
  mkdirSync(area.gatePath, { mode: 0o700 });
  try {
    const acquisition = acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 60 });
    await expect(acquisition).rejects.toBeInstanceOf(FileLockTimeoutError);
    await expect(acquisition).rejects.toThrow("Timed out waiting for file lock");
    expect(lstatSync(area.gatePath).isDirectory()).toBe(true);
    expect(readdirSync(area.gatePath)).toEqual([]);
    expect(existsSync(area.claimsPath)).toBe(false);
  } finally {
    cleanDirectory(area.directory);
  }
});

it("treats Windows mkdir errors as contention only for an actual directory", async () => {
  for (const code of ["EACCES", "EPERM"]) {
    const directoryArea = createArea();
    mkdirSync(directoryArea.gatePath, { mode: 0o700 });
    faults.gatePath = directoryArea.gatePath;
    faults.mkdirCodes = [code];
    const previousFailures = faults.mkdirFailures;
    const previousAttempts = faults.mkdirAttempts;
    const pending = acquireCompatibleDirectoryFileLock(directoryArea.filePath, {
      timeoutMs: 1_000,
    });
    try {
      await waitFor(
        () =>
          faults.mkdirFailures > previousFailures && faults.mkdirAttempts >= previousAttempts + 3,
      );
      rmdirSync(directoryArea.gatePath);
      const handle = await pending;
      expect(lstatSync(directoryArea.gatePath).isDirectory()).toBe(true);
      await handle.release();
    } finally {
      faults.gatePath = "";
      cleanDirectory(directoryArea.directory);
    }

    const fileArea = createArea();
    writeFileSync(fileArea.gatePath, "unowned");
    faults.gatePath = fileArea.gatePath;
    faults.mkdirCodes = [code];
    try {
      await expect(
        acquireCompatibleDirectoryFileLock(fileArea.filePath, { timeoutMs: 60 }),
      ).rejects.toMatchObject({ code });
      expect(readFileSync(fileArea.gatePath, "utf8")).toBe("unowned");
      expect(existsSync(fileArea.claimsPath)).toBe(false);
    } finally {
      faults.gatePath = "";
      cleanDirectory(fileArea.directory);
    }
  }
});

it("keeps one deadline across both locks and preserves acquisition and cleanup errors", async () => {
  const area = createArea();
  const holder = startSharedHolder(area.filePath);
  await holder.entered;
  mkdirSync(area.gatePath, { mode: 0o700 });
  faults.gatePath = area.gatePath;
  faults.mkdirCodes = ["EACCES"];
  const started = performance.now();
  const pending = acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 500 });
  try {
    await waitFor(() => faults.mkdirFailures === 1);
    await delay(300);
    faults.rmdirPath = area.gatePath;
    faults.rmdirCode = "EACCES";
    faults.rmdirFailures = 1;
    rmdirSync(area.gatePath);
    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) throw new Error("Missing cleanup error details");
    expect(thrown.errors).toHaveLength(2);
    expect(thrown.errors[0]).toMatchObject({ message: expect.stringContaining("Timed out") });
    expect(thrown.errors[1]).toMatchObject({ code: "EACCES" });
    expect(performance.now() - started).toBeLessThan(700);
    expect(faults.rmdirAttempts).toBe(1);
    expect(lstatSync(area.gatePath).isDirectory()).toBe(true);
  } finally {
    faults.gatePath = "";
    faults.rmdirPath = "";
    holder.finish();
    await holder.run;
    cleanDirectory(area.directory);
  }
});

it("attempts both releases in order and reports both cleanup errors", async () => {
  const area = createArea();
  const handle = await acquireCompatibleDirectoryFileLock(area.filePath);
  const claimName = readdirSync(area.claimsPath).find((name) => name.endsWith(CLAIM_EXTENSION));
  expect(claimName).toBeDefined();
  if (!claimName) throw new Error("The compatible lock did not create a shared claim");
  faults.rmdirPath = area.gatePath;
  faults.rmdirCode = "EACCES";
  faults.rmdirFailures = 1;
  faults.unlinkPath = join(area.claimsPath, claimName);
  faults.unlinkCode = "EPERM";
  faults.unlinkFailures = 1;

  try {
    const release = handle.release();
    expect(handle.release()).toBe(release);
    let thrown: unknown;
    try {
      await release;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) throw new Error("Missing release error details");
    expect(thrown.errors).toHaveLength(2);
    expect(thrown.errors[0]).toMatchObject({ message: "Could not release file lock claim" });
    expect(thrown.errors[1]).toMatchObject({ code: "EACCES" });
    expect(faults.releaseEvents).toEqual(["claim", "gate"]);
    expect(faults.rmdirAttempts).toBe(1);
    expect(existsSync(area.gatePath)).toBe(true);
  } finally {
    faults.rmdirPath = "";
    faults.unlinkPath = "";
    cleanDirectory(area.directory);
  }
});
