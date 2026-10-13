import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ phase: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!String(args[0]).endsWith(".tmp")) return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "writeFile" && fault.phase === "write")
            return async () => {
              throw new Error("injected write failure");
            };
          if (key === "sync" && fault.phase === "sync")
            return async () => {
              throw new Error("injected sync failure");
            };
          if (key === "close" && fault.phase === "close")
            return async () => {
              await target.close();
              throw new Error("injected close failure");
            };
          return Reflect.get(target, key, target);
        },
      });
    },
  };
});

import { replacePrivateFile } from "./atomic-file.js";

beforeEach(() => {
  fault.phase = "";
});

it.each(["write", "sync", "close"] as const)(
  "removes the staged file when %s fails",
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "capture-atomic-replacement-"));
    const path = join(root, "record.json");
    await writeFile(path, "before", { mode: 0o600 });
    fault.phase = phase;

    await expect(replacePrivateFile(root, path, "after")).rejects.toThrow();

    fault.phase = "";
    await expect(readFile(path, "utf8")).resolves.toBe("before");
    await expect(readdir(root)).resolves.toEqual(["record.json"]);
  },
);
