import { expect, it, vi } from "vitest";
import { temporaryRoot } from "../../test-support/tracing/delivery.js";
import type { BackgroundWorkerOptions } from "./models.js";

it("rechecks pending wakes after releasing the worker lock", async () => {
  let afterRun: (() => Promise<void>) | undefined;
  vi.doMock("../../storage/index.js", async (importOriginal) => {
    const storage = await importOriginal<typeof import("../../storage/index.js")>();
    return {
      ...storage,
      withFileLock: async <T>(path: string, callback: () => T | Promise<T>) => {
        const lock = await storage.tryAcquireFileLock(path);
        try {
          const result = await callback();
          const injected = afterRun;
          afterRun = undefined;
          await injected?.();
          return result;
        } finally {
          await lock?.release();
        }
      },
    };
  });
  const { createBackgroundWorker } = await import("./worker.js");
  const scope = { integration: "claude", sessionId: "handoff", accountFingerprint: "account" };
  let passes = 0;
  const options: BackgroundWorkerOptions = {
    storageRoot: temporaryRoot(),
    scope,
    resolveScope: () => scope,
    launchWorker: () => {
      throw new Error("unexpected launch");
    },
    drainPending: () => {
      passes += 1;
      return "idle";
    },
  };
  const worker = createBackgroundWorker(options);
  await worker.wake().catch(() => {});
  afterRun = async () => {
    await expect(createBackgroundWorker(options).wake()).resolves.toBe("queued");
  };
  await expect(worker.run()).resolves.toBe("completed");
  expect(passes).toBe(2);
  vi.doUnmock("../../storage/index.js");
});
