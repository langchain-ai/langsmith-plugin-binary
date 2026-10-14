import { expect, it, vi } from "vitest";
import { tryAcquireFileLock } from "../../storage/index.js";
import { temporaryRoot } from "../../test-support/tracing/delivery.js";
import { workerLockPath } from "./paths.js";
import { createBackgroundWorker } from "./worker.js";

vi.mock("./constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./constants.js")>()),
  BACKGROUND_WORKER_OWNER_WAIT_MS: 50,
}));

const scope = { integration: "claude", sessionId: "busy-session", accountFingerprint: "account" };

it("returns busy instead of throwing when another worker holds the lock", async () => {
  const root = temporaryRoot();
  const drainPending = vi.fn(async () => "idle" as const);
  const worker = createBackgroundWorker({
    storageRoot: root,
    scope,
    resolveScope: () => scope,
    launchWorker: async () => 1,
    drainPending,
  });
  const holder = await tryAcquireFileLock(workerLockPath(root, scope));
  try {
    await expect(worker.run()).resolves.toBe("busy");
  } finally {
    await holder!.release();
  }
  expect(drainPending).not.toHaveBeenCalled();
});
