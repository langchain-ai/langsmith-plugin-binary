import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { publishExclusive, replacePrivateFile } from "./atomic-file.js";

const events = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      events.push("link");
      return actual.link(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      events.push("rename");
      return actual.rename(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const kind = typeof args[1] === "number" ? "directory" : "file";
      return new Proxy(handle, {
        get(target, key) {
          if (key === "sync")
            return async () => {
              events.push(`${kind}-sync`);
            };
          return Reflect.get(target, key, target);
        },
      });
    },
  };
});

const syncsDirectories = process.platform !== "win32";

beforeEach(() => {
  events.length = 0;
});

it("syncs the new file before linking it and the folder after", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-atomic-publish-"));
  await expect(publishExclusive(join(root, "record.json"), "contents")).resolves.toBe(true);
  expect(events).toEqual(["file-sync", "link", ...(syncsDirectories ? ["directory-sync"] : [])]);
});

it("syncs the replacement file before renaming it and the folder after", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-atomic-replace-"));
  const path = join(root, "record.json");
  await writeFile(path, "before", { mode: 0o600 });
  await replacePrivateFile(root, path, "after");
  expect(events).toEqual(["file-sync", "rename", ...(syncsDirectories ? ["directory-sync"] : [])]);
});
