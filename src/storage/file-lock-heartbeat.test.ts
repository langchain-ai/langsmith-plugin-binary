import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FILE_LOCK_HEARTBEAT_MS, FILE_LOCK_HEARTBEAT_WARNING } from "./constants.js";
import { withFileLock } from "./file-lock.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    utimes: async () => {
      throw Object.assign(new Error("injected refresh failure"), { code: "EACCES" });
    },
  };
});

it("warns when a held lock cannot refresh its claim", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const directory = await mkdtemp(join(tmpdir(), "lock-heartbeat-"));
  await withFileLock(join(directory, "target"), async () => {
    await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_HEARTBEAT_MS * 2));
  });
  expect(warn).toHaveBeenCalledWith(
    FILE_LOCK_HEARTBEAT_WARNING,
    expect.stringContaining("injected"),
  );
  warn.mockRestore();
});
