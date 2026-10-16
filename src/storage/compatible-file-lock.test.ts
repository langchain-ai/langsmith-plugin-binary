import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitFor } from "../test-support/wait.js";
import { FILE_LOCK_WINDOWS_DENIED_RETRIES, STORAGE_NOT_WRITABLE_FIX } from "./constants.js";
import { FileLockTimeoutError, StorageNotWritableError } from "./index.js";
import { waitForNextScan } from "./file-lock-support.js";
import {
  acquireCompatibleDirectoryFileLock,
  tryAcquireFileLock,
  withFileLock,
} from "./file-lock.js";

const faults = vi.hoisted(() => ({
  gatePath: "",
  mkdirCodes: [] as string[],
  mkdirAttempts: 0,
  mkdirFailures: 0,
  createGateBeforeRejectAt: 0,
  removeGateDuringLstat: "",
  vanishGateBeforeReject: "",
  rmdirPath: "",
  rmdirCode: "",
  rmdirFailures: 0,
  rmdirAttempts: 0,
  unlinkPath: "",
  unlinkCode: "",
  unlinkFailures: 0,
  unlinkAttempts: 0,
  writeFilePath: "",
  renamePath: "",
  renameCode: "",
  renameFailures: 0,
  renameAttempts: 0,
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
          if (faults.createGateBeforeRejectAt === faults.mkdirAttempts) {
            faults.createGateBeforeRejectAt = 0;
            await actual.mkdir(String(args[0]), { mode: 0o700 });
          }
          if (faults.vanishGateBeforeReject === String(args[0])) {
            faults.vanishGateBeforeReject = "";
            await actual.rmdir(String(args[0]));
          }
          throw Object.assign(new Error("Injected lock-directory contention"), { code });
        }
      }
      return actual.mkdir(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args);
      if (String(args[0]) === faults.gatePath && stat.isDirectory()) {
        if (faults.removeGateDuringLstat === String(args[0])) {
          faults.removeGateDuringLstat = "";
          await actual.rmdir(String(args[0]));
        }
      }
      return stat;
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
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[0]) === faults.renamePath) {
        faults.renameAttempts += 1;
        if (faults.renameFailures > 0) {
          faults.renameFailures -= 1;
          throw Object.assign(new Error("Injected gate rename contention"), {
            code: faults.renameCode,
          });
        }
      }
      return actual.rename(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]) === faults.writeFilePath)
        throw Object.assign(new Error("Injected owner write failure"), { code: "EIO" });
      return actual.writeFile(...args);
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

vi.mock("./file-lock-support.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./file-lock-support.js")>();
  return { ...actual, waitForNextScan: vi.fn(actual.waitForNextScan) };
});

const scanWaits = vi.mocked(waitForNextScan);
const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function gateWaits(gatePath: string): number {
  return scanWaits.mock.calls.filter(([, path]) => path === gatePath).length;
}

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

afterEach(() => {
  if (hostPlatform) Object.defineProperty(process, "platform", hostPlatform);
});

beforeEach(() => {
  scanWaits.mockClear();
  faults.gatePath = "";
  faults.mkdirCodes = [];
  faults.mkdirAttempts = 0;
  faults.mkdirFailures = 0;
  faults.createGateBeforeRejectAt = 0;
  faults.removeGateDuringLstat = "";
  faults.vanishGateBeforeReject = "";
  faults.rmdirPath = "";
  faults.rmdirCode = "";
  faults.rmdirFailures = 0;
  faults.rmdirAttempts = 0;
  faults.unlinkPath = "";
  faults.unlinkCode = "";
  faults.unlinkFailures = 0;
  faults.unlinkAttempts = 0;
  faults.writeFilePath = "";
  faults.renamePath = "";
  faults.renameCode = "";
  faults.renameFailures = 0;
  faults.renameAttempts = 0;
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
    await waitFor(
      () =>
        existsSync(area.gatePath) &&
        existsSync(area.claimsPath) &&
        readdirSync(area.claimsPath).filter((name) => name.endsWith(CLAIM_EXTENSION)).length === 2,
    );
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

    const releasedArea = createArea();
    mkdirSync(releasedArea.gatePath, { mode: 0o700 });
    faults.gatePath = releasedArea.gatePath;
    faults.mkdirCodes = [code];
    faults.vanishGateBeforeReject = releasedArea.gatePath;
    const previousRaceFailures = faults.mkdirFailures;
    try {
      const handle = await acquireCompatibleDirectoryFileLock(releasedArea.filePath, {
        timeoutMs: 1_000,
      });
      expect(faults.mkdirFailures).toBe(previousRaceFailures + 1);
      expect(lstatSync(releasedArea.gatePath).isDirectory()).toBe(true);
      await handle.release();
    } finally {
      faults.gatePath = "";
      cleanDirectory(releasedArea.directory);
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

    const deniedArea = createArea();
    faults.gatePath = deniedArea.gatePath;
    faults.mkdirCodes = Array.from({ length: 100 }, () => code);
    const previousDenials = faults.mkdirFailures;
    try {
      await expect(
        acquireCompatibleDirectoryFileLock(deniedArea.filePath, { timeoutMs: 60 }),
      ).rejects.toMatchObject({ code });
      expect(faults.mkdirFailures).toBeGreaterThanOrEqual(previousDenials + 2);
      expect(existsSync(deniedArea.gatePath)).toBe(false);
      expect(existsSync(deniedArea.claimsPath)).toBe(false);
    } finally {
      faults.gatePath = "";
      faults.mkdirCodes = [];
      cleanDirectory(deniedArea.directory);
    }
  }
});

it("retries missing-gate permission errors after an existence race", async () => {
  for (const code of ["EACCES", "EPERM"]) {
    const area = createArea();
    faults.gatePath = area.gatePath;
    faults.mkdirCodes = [code, "EEXIST", code];
    const previousAttempts = faults.mkdirAttempts;
    const previousFailures = faults.mkdirFailures;
    try {
      const handle = await acquireCompatibleDirectoryFileLock(area.filePath, {
        timeoutMs: 1_000,
      });
      expect(faults.mkdirAttempts).toBe(previousAttempts + 4);
      expect(faults.mkdirFailures).toBe(previousFailures + 3);
      expect(lstatSync(area.gatePath).isDirectory()).toBe(true);
      await handle.release();
    } finally {
      faults.gatePath = "";
      cleanDirectory(area.directory);
    }
  }
});

it("keeps retrying a Windows mid-delete permission error until the folder can be created", async () => {
  setPlatform("win32");
  const area = createArea();
  faults.gatePath = area.gatePath;
  faults.mkdirCodes = ["EPERM", "EPERM", "EPERM", "EPERM", "EPERM"];
  try {
    const handle = await acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 1_000 });
    expect(faults.mkdirFailures).toBe(5);
    expect(gateWaits(area.gatePath)).toBe(4);
    expect(lstatSync(area.gatePath).isDirectory()).toBe(true);
    await handle.release();
  } finally {
    faults.gatePath = "";
    cleanDirectory(area.directory);
  }
});

it.each([
  ["linux", "EACCES"],
  ["linux", "EPERM"],
  ["win32", "EACCES"],
] as const)("fails at once on a %s %s for a missing lock folder", async (platform, code) => {
  setPlatform(platform);
  const area = createArea();
  faults.gatePath = area.gatePath;
  faults.mkdirCodes = Array.from({ length: 100 }, () => code);
  try {
    const pending = acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 5_000 });
    await expect(pending).rejects.toBeInstanceOf(StorageNotWritableError);
    await expect(pending).rejects.toMatchObject({ code, folder: area.directory });
    expect(faults.mkdirFailures).toBe(2);
    expect(gateWaits(area.gatePath)).toBe(0);
  } finally {
    faults.gatePath = "";
    faults.mkdirCodes = [];
    cleanDirectory(area.directory);
  }
});

it("reports the Windows permission error when the deadline passes", async () => {
  setPlatform("win32");
  const deniedArea = createArea();
  faults.gatePath = deniedArea.gatePath;
  faults.mkdirCodes = Array.from({ length: 1_000 }, () => "EPERM");
  try {
    const pending = acquireCompatibleDirectoryFileLock(deniedArea.filePath, { timeoutMs: 20 });
    await expect(pending).rejects.toMatchObject({ code: "EPERM" });
    await expect(pending).rejects.not.toBeInstanceOf(FileLockTimeoutError);
  } finally {
    faults.gatePath = "";
    faults.mkdirCodes = [];
    cleanDirectory(deniedArea.directory);
  }

  const area = createArea();
  faults.gatePath = area.gatePath;
  faults.mkdirCodes = ["EPERM", "EPERM"];
  scanWaits.mockImplementationOnce((_deadline, path) =>
    Promise.reject(new FileLockTimeoutError(path)),
  );
  try {
    const pending = acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 1_000 });
    await expect(pending).rejects.toBeInstanceOf(StorageNotWritableError);
    await expect(pending).rejects.toMatchObject({ code: "EPERM" });
  } finally {
    faults.gatePath = "";
    faults.mkdirCodes = [];
    cleanDirectory(area.directory);
  }
});

it("gives up on a denied Windows lock folder after a few quick tries", async () => {
  setPlatform("win32");
  const area = createArea();
  faults.gatePath = area.gatePath;
  faults.mkdirCodes = Array.from({ length: 1_000 }, () => "EPERM");
  const started = performance.now();
  try {
    const pending = acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 5_000 });
    await expect(pending).rejects.toBeInstanceOf(StorageNotWritableError);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(gateWaits(area.gatePath)).toBe(FILE_LOCK_WINDOWS_DENIED_RETRIES);
    expect(faults.mkdirFailures).toBe(FILE_LOCK_WINDOWS_DENIED_RETRIES + 2);
  } finally {
    faults.gatePath = "";
    faults.mkdirCodes = [];
    cleanDirectory(area.directory);
  }
});

it("gives each Windows mid-delete a fresh set of quick tries", async () => {
  setPlatform("win32");
  const area = createArea();
  const deleting = Array.from({ length: FILE_LOCK_WINDOWS_DENIED_RETRIES + 1 }, () => "EPERM");
  faults.gatePath = area.gatePath;
  faults.mkdirCodes = [...deleting, "EEXIST", ...deleting];
  try {
    const handle = await acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 5_000 });
    expect(lstatSync(area.gatePath).isDirectory()).toBe(true);
    await handle.release();
  } finally {
    faults.gatePath = "";
    faults.mkdirCodes = [];
    cleanDirectory(area.directory);
  }
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "tells the user which storage folder needs its permissions fixed",
  async () => {
    const area = createArea();
    chmodSync(area.directory, 0o500);
    try {
      const pending = acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 5_000 });
      await expect(pending).rejects.toThrow(`${area.directory}. ${STORAGE_NOT_WRITABLE_FIX}`);
    } finally {
      chmodSync(area.directory, 0o700);
      cleanDirectory(area.directory);
    }
  },
);

it("times out rather than reporting an earlier permission error once the folder was seen", async () => {
  const raceArea = createArea();
  faults.gatePath = raceArea.gatePath;
  faults.mkdirCodes = ["EPERM", ...Array.from({ length: 1_000 }, () => "EEXIST")];
  try {
    await expect(
      acquireCompatibleDirectoryFileLock(raceArea.filePath, { timeoutMs: 60 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  } finally {
    faults.gatePath = "";
    faults.mkdirCodes = [];
    cleanDirectory(raceArea.directory);
  }

  const heldArea = createArea();
  faults.gatePath = heldArea.gatePath;
  faults.mkdirCodes = ["EPERM", "EEXIST"];
  faults.createGateBeforeRejectAt = faults.mkdirAttempts + 2;
  try {
    await expect(
      acquireCompatibleDirectoryFileLock(heldArea.filePath, { timeoutMs: 60 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  } finally {
    faults.gatePath = "";
    cleanDirectory(heldArea.directory);
  }
});

it("resets the missing-gate retry after observing a contended directory", async () => {
  const code = "EPERM";
  const area = createArea();
  mkdirSync(area.gatePath, { mode: 0o700 });
  faults.gatePath = area.gatePath;
  faults.mkdirCodes = [code, code, code];
  faults.vanishGateBeforeReject = area.gatePath;
  const previousAttempts = faults.mkdirAttempts;
  const previousFailures = faults.mkdirFailures;
  faults.createGateBeforeRejectAt = previousAttempts + 2;
  faults.removeGateDuringLstat = area.gatePath;
  const pending = acquireCompatibleDirectoryFileLock(area.filePath, {
    timeoutMs: 1_000,
  });
  try {
    await pending;
    expect(faults.mkdirAttempts).toBe(previousAttempts + 4);
    expect(faults.mkdirFailures).toBe(previousFailures + 3);
  } finally {
    faults.gatePath = "";
    await pending.then(
      (handle) => handle.release().catch(() => undefined),
      () => undefined,
    );
    cleanDirectory(area.directory);
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

function exitedProcessId(): number {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/process-pid.mjs", import.meta.url))],
    {
      encoding: "utf8",
    },
  );
  return Number(child.stdout);
}

it("reclaims a gate left by a dead holder and a dead or old legacy lock file", async () => {
  const deadPid = exitedProcessId();
  const deadDirectory = createArea();
  mkdirSync(deadDirectory.gatePath, { mode: 0o700 });
  writeFileSync(join(deadDirectory.gatePath, "owner"), String(deadPid));
  const deadFile = createArea();
  writeFileSync(deadFile.gatePath, String(deadPid));
  const oldEmptyFile = createArea();
  writeFileSync(oldEmptyFile.gatePath, "");
  utimesSync(oldEmptyFile.gatePath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  try {
    for (const area of [deadDirectory, deadFile, oldEmptyFile]) {
      const handle = await acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 1_000 });
      expect(readFileSync(join(area.gatePath, "owner"), "utf8")).toBe(String(process.pid));
      await handle.release();
      expect(existsSync(area.gatePath)).toBe(false);
      expect(readdirSync(area.directory).filter((name) => name.endsWith(".stale"))).toEqual([]);
    }
  } finally {
    for (const area of [deadDirectory, deadFile, oldEmptyFile]) cleanDirectory(area.directory);
  }
});

it("keeps waiting for a live, unknown or ownerless legacy holder", async () => {
  const liveFile = createArea();
  writeFileSync(liveFile.gatePath, String(process.pid));
  const unknownPid = process.platform === "win32" ? 4 : 1;
  const unknownOwner = createArea();
  writeFileSync(unknownOwner.gatePath, String(unknownPid));
  const ownerless = createArea();
  mkdirSync(ownerless.gatePath, { mode: 0o700 });
  const areas = [liveFile, unknownOwner, ownerless];
  for (const area of areas)
    utimesSync(area.gatePath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  try {
    for (const area of areas)
      await expect(
        acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 60 }),
      ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(readFileSync(liveFile.gatePath, "utf8")).toBe(String(process.pid));
    expect(readFileSync(unknownOwner.gatePath, "utf8")).toBe(String(unknownPid));
    expect(readdirSync(ownerless.gatePath)).toEqual([]);
  } finally {
    for (const area of areas) cleanDirectory(area.directory);
  }
});

it.each([
  ["EBUSY", true],
  ["ENOENT", false],
])("warns when a half-created legacy gate cannot be removed (%s)", async (code, warns) => {
  const area = createArea();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  faults.writeFilePath = join(area.gatePath, "owner");
  faults.rmdirPath = area.gatePath;
  faults.rmdirCode = code;
  faults.rmdirFailures = 1;
  try {
    await expect(
      acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 1_000 }),
    ).rejects.toThrow("Could not record the legacy file lock gate owner");
    if (warns)
      expect(warn).toHaveBeenCalledWith(
        "Could not remove a half-created lock folder:",
        "Injected legacy gate cleanup failure",
      );
    else expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    faults.rmdirPath = "";
    faults.writeFilePath = "";
    if (existsSync(area.gatePath)) rmdirSync(area.gatePath);
    cleanDirectory(area.directory);
  }
});

it("keeps trying to reclaim a dead holder's gate while it is busy", async () => {
  const area = createArea();
  mkdirSync(area.gatePath, { mode: 0o700 });
  writeFileSync(join(area.gatePath, "owner"), String(exitedProcessId()));
  faults.renamePath = area.gatePath;
  faults.renameCode = "EBUSY";
  faults.renameFailures = 2;
  try {
    const handle = await acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 2_000 });
    expect(faults.renameAttempts).toBe(3);
    expect(readFileSync(join(area.gatePath, "owner"), "utf8")).toBe(String(process.pid));
    await handle.release();
  } finally {
    cleanDirectory(area.directory);
  }
});

it("reclaims a gate whose owner pid looks alive but stopped refreshing its owner file", async () => {
  const area = createArea();
  mkdirSync(area.gatePath, { mode: 0o700 });
  const owner = join(area.gatePath, "owner");
  writeFileSync(owner, String(process.pid));
  utimesSync(owner, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  try {
    const handle = await acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 1_000 });
    await handle.release();
    expect(existsSync(area.gatePath)).toBe(false);
  } finally {
    cleanDirectory(area.directory);
  }
});

it("keeps waiting for a live owner that refreshed its owner file recently", async () => {
  const area = createArea();
  mkdirSync(area.gatePath, { mode: 0o700 });
  writeFileSync(join(area.gatePath, "owner"), String(process.pid));
  try {
    await expect(
      acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(readFileSync(join(area.gatePath, "owner"), "utf8")).toBe(String(process.pid));
  } finally {
    cleanDirectory(area.directory);
  }
});

it("keeps refreshing the owner file while the gate is held", async () => {
  const area = createArea();
  const handle = await acquireCompatibleDirectoryFileLock(area.filePath, { timeoutMs: 1_000 });
  const owner = join(area.gatePath, "owner");
  try {
    utimesSync(owner, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    await waitFor(() => Date.now() - lstatSync(owner).mtimeMs < 2_000);
  } finally {
    await handle.release();
    cleanDirectory(area.directory);
  }
});
