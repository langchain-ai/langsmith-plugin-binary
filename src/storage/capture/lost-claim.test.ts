import { mkdtempSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCaptureStore } from "./capture-store.js";

const hooks = vi.hoisted(() => ({ beforeCommit: undefined as undefined | (() => void) }));

vi.mock("./utils/atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/atomic-file.js")>();
  return {
    ...actual,
    replacePrivateFile: (
      root: string,
      path: string,
      contents: string,
      beforeCommit?: () => Promise<void>,
    ) =>
      actual.replacePrivateFile(root, path, contents, async () => {
        hooks.beforeCommit?.();
        await beforeCommit?.();
      }),
  };
});

const scope = { integration: "claude-code", sessionId: "s", turnId: "t", eventId: "e" };

function takeOverEveryClaim(root: string): void {
  for (const entry of readdirSync(join(root, "record-lock-v1"), {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isFile() && entry.parentPath.endsWith(".claims"))
      unlinkSync(join(entry.parentPath, entry.name));
}

it("does not overwrite a newer holder's work after its own lock was taken over", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugins-base-lost-claim-"));
  const store = createCaptureStore(root);
  await store.capture({
    ...scope,
    runId: "r",
    destinationFingerprint: "account",
    eventKind: "run-post",
    normalizedPayload: {},
    turnEvidence: {},
    metadataProvenance: {},
  });
  hooks.beforeCommit = () => takeOverEveryClaim(root);
  await expect(
    store.recordOutcome({ ...scope, destination: "a", outcome: "delivered" }),
  ).resolves.toMatchObject({ status: "failed", message: expect.stringContaining("taken over") });
  hooks.beforeCommit = undefined;
  await expect(store.readOutcome(scope, "a")).resolves.toEqual({ status: "pending" });
  await expect(
    store.recordRetry(scope, "a", { failures: 1, notBeforeMs: 1 }),
  ).resolves.toBeUndefined();
});
