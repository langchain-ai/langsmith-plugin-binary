import { mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { STORAGE_STALE_DIRECTORY_WARNING } from "./constants.js";
import { removeStaleStorageFiles } from "./stale-files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rmdir: async () => {
      throw Object.assign(new Error("injected folder failure"), { code: "EACCES" });
    },
  };
});

it("warns when an old empty folder cannot be removed", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const root = mkdtempSync(join(tmpdir(), "plugins-base-stale-warning-"));
  const folder = join(root, "background-worker", "old-empty");
  mkdirSync(folder, { recursive: true });
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(folder, old, old);
  await removeStaleStorageFiles(root, ["background-worker"], Date.now() - 60 * 60 * 1000);
  expect(warn).toHaveBeenCalledWith(
    STORAGE_STALE_DIRECTORY_WARNING,
    expect.stringContaining("injected"),
  );
  warn.mockRestore();
});
