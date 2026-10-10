import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BACKGROUND_WORKER_MARKER_VERSION } from "./constants.js";
import type { BackgroundWorkerOptions, BackgroundWorkerScope } from "./models.js";
import { workerPendingPath } from "./paths.js";

let testRoot: string | undefined;

function cleanupRoot(root: string): void {
  const directories = [root];
  const orderedDirectories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        directories.push(path);
        orderedDirectories.push(path);
      } else {
        unlinkSync(path);
      }
    }
  }
  for (const directory of orderedDirectories.toReversed()) rmdirSync(directory);
}

afterEach(() => {
  if (testRoot && existsSync(testRoot)) cleanupRoot(testRoot);
  testRoot = undefined;
  vi.doUnmock("../../storage/index.js");
  vi.resetModules();
});

it("rechecks pending wakes after releasing the worker lock", async () => {
  let afterLockedRun: (() => Promise<void>) | undefined;
  let injectWake = false;
  vi.doMock("../../storage/index.js", async (importOriginal) => {
    const storage = await importOriginal<typeof import("../../storage/index.js")>();
    return {
      ...storage,
      withFileLock: async <T>(filePath: string, callback: () => T | Promise<T>): Promise<T> => {
        const lock = await storage.tryAcquireFileLock(filePath);
        if (!lock) throw new Error("Test lock was unexpectedly busy");
        try {
          const result = await callback();
          if (injectWake) {
            injectWake = false;
            await afterLockedRun?.();
          }
          return result;
        } finally {
          await lock.release();
        }
      },
    };
  });
  const { createBackgroundWorker } = await import("./worker.js");
  const storageRoot = mkdtempSync(join(tmpdir(), "plugins base worker handoff-"));
  testRoot = storageRoot;
  const scope: BackgroundWorkerScope = {
    integration: "claude",
    accountFingerprint: "worker-handoff-test-account",
  };
  const statePath = join(storageRoot, "passes");
  let passes = 0;
  let launches = 0;
  const firstOptions: BackgroundWorkerOptions = {
    storageRoot,
    scope,
    resolveScope: () => scope,
    launchWorker: () => {
      throw new Error("unexpected worker launch");
    },
    drainPending: () => {
      passes += 1;
      writeFileSync(statePath, String(passes));
      return "idle";
    },
  };
  const secondOptions: BackgroundWorkerOptions = {
    ...firstOptions,
    launchWorker: () => {
      launches += 1;
      throw new Error("unexpected competing launch");
    },
    drainPending: () => "idle",
  };
  const firstWorker = createBackgroundWorker(firstOptions);
  const secondWorker = createBackgroundWorker(secondOptions);
  await expect(firstWorker.run()).resolves.toBe("idle");
  writeFileSync(
    workerPendingPath(storageRoot, scope),
    JSON.stringify({
      version: BACKGROUND_WORKER_MARKER_VERSION,
      id: randomUUID(),
      sourcePid: process.pid,
    }),
    { flag: "wx", mode: 0o600 },
  );
  afterLockedRun = async () => {
    await expect(secondWorker.wake()).resolves.toBe("queued");
  };
  injectWake = true;

  await expect(firstWorker.run()).resolves.toBe("completed");

  expect(passes).toBe(2);
  expect(launches).toBe(0);
  expect(existsSync(workerPendingPath(storageRoot, scope))).toBe(false);
});
