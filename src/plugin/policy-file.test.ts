import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childEnvironment, moduleUrl } from "../test-support/tracing/delivery.js";
import { withFileLock } from "../storage/index.js";
import { readPolicyFile, updatePolicyFile } from "./policy-file.js";
import type { Policy } from "../test-support/models/policy.js";
import type { PolicyFileOptions } from "./models.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const options: PolicyFileOptions<Policy> = {
  empty: () => ({ names: [] }),
  parse: (value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !Array.isArray((value as Policy).names) ||
      Object.keys(value).length !== 1
    )
      throw new Error("Invalid tracing preference format");
    return value as Policy;
  },
};
async function lateUpdate(policy: Policy): Promise<void> {
  await Promise.resolve();
  policy.names = [...policy.names, "late"];
}
const add = (name: string) => (policy: Policy) => {
  policy.names = [...policy.names, name];
};
let home: string;
let file: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plugins base policy "));
  file = join(home, "state", "privacy.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const saved = () => (JSON.parse(readFileSync(file, "utf8")) as Policy).names;

function expectOnlyPolicyLeft(): void {
  expect(readdirSync(dirname(file))).toEqual([basename(file)]);
}

function runWriter(target: string, directory: string, prefix: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/policy-writer.mjs", import.meta.url)),
        moduleUrl("dist/plugin/index.js"),
        target,
        prefix,
        "8",
      ],
      { env: childEnvironment(directory), stdio: "ignore" },
    );
    child.once("exit", resolve);
  });
}

function deferred() {
  const handle: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    handle.resolve = resolve;
  });
  return { promise, resolve: () => handle.resolve?.() };
}

describe("reading a policy file", () => {
  it("treats a missing file as an empty policy", () => {
    expect(readPolicyFile(file, options)).toEqual({ names: [] });
  });

  it("returns a valid policy and rejects an invalid one", () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"names":["a"]}');
    expect(readPolicyFile(file, options)).toEqual({ names: ["a"] });
    writeFileSync(file, '{"names":["a"],"extra":1}');
    expect(() => readPolicyFile(file, options)).toThrow("Invalid tracing preference format");
    writeFileSync(file, "{ not json");
    expect(() => readPolicyFile(file, options)).toThrow();
  });

  it("fails closed on a dangling symlink and on a directory in the way", () => {
    mkdirSync(dirname(file), { recursive: true });
    symlinkSync(join(home, "missing"), file);
    expect(() => readPolicyFile(file, options)).toThrow();
    rmSync(file);
    mkdirSync(file);
    expect(() => readPolicyFile(file, options)).toThrow();
  });

  it("follows a readable symlink unless a regular file is required", () => {
    mkdirSync(dirname(file), { recursive: true });
    const target = join(home, "target.json");
    writeFileSync(target, '{"names":["via-link"]}');
    symlinkSync(target, file);
    expect(readPolicyFile(file, options)).toEqual({ names: ["via-link"] });
    expect(() => readPolicyFile(file, { ...options, requireRegularFile: true })).toThrow(
      "regular, non-symlink file",
    );
  });
});

describe("updating a policy file", () => {
  it("creates missing folders and writes a private file", async () => {
    await expect(updatePolicyFile(file, options, add("first"))).resolves.toEqual({});
    expect(saved()).toEqual(["first"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expectOnlyPolicyLeft();
  });

  it("refuses to overwrite a policy it cannot read and leaves it as it was", async () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{ not json");
    await expect(updatePolicyFile(file, options, add("x"))).rejects.toThrow(
      "Refusing to overwrite",
    );
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    rmSync(file);
    symlinkSync(join(home, "missing"), file);
    await expect(updatePolicyFile(file, options, add("x"))).rejects.toThrow(
      "Refusing to overwrite",
    );
  });

  it("rejects an update that returns a promise instead of changing the policy later", async () => {
    await updatePolicyFile(file, options, add("first"));
    await expect(updatePolicyFile(file, options, lateUpdate)).rejects.toThrow(TypeError);
    expect(saved()).toEqual(["first"]);
    expectOnlyPolicyLeft();
  });

  it("writes the policy an update returns instead of the one it was given", async () => {
    await updatePolicyFile(file, options, () => ({ names: ["returned"] }));
    expect(saved()).toEqual(["returned"]);
  });

  it("rejects a parser that returns nothing without writing the file", async () => {
    const broken: PolicyFileOptions<Policy> = {
      empty: () => ({ names: [] }),
      parse: () => undefined as unknown as Policy,
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"names":[]}\n');
    await expect(updatePolicyFile(file, broken, add("x"))).rejects.toThrow(
      "Cannot read tracing preferences",
    );
    expect(readFileSync(file, "utf8")).toBe('{"names":[]}\n');
  });

  it("refuses to write through a readable symlink when a regular file is required", async () => {
    mkdirSync(dirname(file), { recursive: true });
    const target = join(home, "target.json");
    writeFileSync(target, '{"names":["keep"]}');
    symlinkSync(target, file);
    await expect(
      updatePolicyFile(file, { ...options, requireRegularFile: true }, add("x")),
    ).rejects.toThrow("Refusing to overwrite");
    expect(readFileSync(target, "utf8")).toBe('{"names":["keep"]}');
  });

  it("keeps every edit when many writers run together", async () => {
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        updatePolicyFile(file, options, add(`writer-${index}`)),
      ),
    );
    expect(saved().toSorted()).toEqual(
      Array.from({ length: 16 }, (_, index) => `writer-${index}`).toSorted(),
    );
    expectOnlyPolicyLeft();
  });

  it("keeps every edit when separate processes write together", async () => {
    await expect(
      Promise.all([
        runWriter(file, home, "a"),
        runWriter(file, home, "b"),
        runWriter(file, home, "c"),
      ]),
    ).resolves.toEqual([0, 0, 0]);
    expect(saved()).toHaveLength(24);
    expect(new Set(saved()).size).toBe(24);
  }, 60_000);

  it("holds its claim until the new file is committed", async () => {
    const gate = deferred();
    const reached = deferred();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[1]) === file) {
        reached.resolve();
        await gate.promise;
      }
      return rename(...args);
    });
    const pending = updatePolicyFile(file, options, add("held"));
    try {
      await reached.promise;
      expect(readdirSync(`${file}.claims`)).toHaveLength(1);
      expect(existsSync(`${file}.lock`)).toBe(true);
    } finally {
      gate.resolve();
      await pending;
    }
    expectOnlyPolicyLeft();
  });

  it("never steals a freshly made lock and names the old lock folder that blocked", async () => {
    mkdirSync(`${file}.lock`, { recursive: true, mode: 0o700 });
    const start = performance.now();
    await expect(updatePolicyFile(file, options, add("x"))).rejects.toThrow(`${file}.lock. Retry`);
    expect(performance.now() - start).toBeGreaterThanOrEqual(2000);
    expect(performance.now() - start).toBeLessThan(2800);
    expect(existsSync(`${file}.lock`)).toBe(true);
  });

  it("names the claims folder when a live claim is what blocked", async () => {
    mkdirSync(dirname(file), { recursive: true });
    await withFileLock(file, async () => {
      await expect(updatePolicyFile(file, options, add("x"))).rejects.toThrow(
        `${file}.claims. Retry`,
      );
    });
  });

  it.each(["rename", "writeFile", "sync", "close"] as const)(
    "keeps the old policy and cleans up when the %s step fails before the commit",
    async (fault) => {
      await updatePolicyFile(file, options, add("first"));
      const before = readFileSync(file, "utf8");
      if (fault === "rename") {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (String(args[1]) === file) throw new Error("rename failed");
          return rename(...args);
        });
      } else {
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (String(args[0]).endsWith(".tmp")) {
            const close = handle.close.bind(handle);
            vi.spyOn(handle, fault).mockImplementationOnce(async () => {
              if (fault === "close") await close();
              throw new Error(`${fault} failed`);
            });
          }
          return handle;
        });
      }
      await expect(updatePolicyFile(file, options, add("second"))).rejects.toThrow(
        `${fault} failed`,
      );
      expect(readFileSync(file, "utf8")).toBe(before);
      expectOnlyPolicyLeft();
    },
  );

  it("reports the original error when closing the temporary file fails too", async () => {
    const open = fs.open;
    let closed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("write failed"));
        vi.spyOn(handle, "close").mockImplementationOnce(async () => {
          closed = true;
          await close();
          throw new Error("close failed");
        });
      }
      return handle;
    });
    await expect(updatePolicyFile(file, options, add("x"))).rejects.toThrow("write failed");
    expect(closed).toBe(true);
    expect(readdirSync(dirname(file))).toEqual([]);
  });

  it.for(["directory open", "directory sync", "directory close", "lock release"])(
    "reports a saved policy with a warning when %s fails after the commit",
    async (fault, context) => {
      if (process.platform === "win32" && fault !== "lock release") context.skip();
      await updatePolicyFile(file, options, add("first"));
      const open = fs.open;
      const renames = vi.spyOn(fs, "rename");
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (String(args[0]) !== dirname(file)) return open(...args);
        if (fault === "directory open") throw new Error(`${fault} failed`);
        const handle = await open(...args);
        if (fault === "directory sync")
          vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error(`${fault} failed`));
        if (fault === "directory close") {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementationOnce(async () => {
            await close();
            throw new Error(`${fault} failed`);
          });
        }
        return handle;
      });
      if (fault === "lock release")
        vi.spyOn(fs, "rmdir").mockRejectedValueOnce(new Error(`${fault} failed`));
      const result = await updatePolicyFile(file, options, add("second"));
      expect(result.warning).toContain(`${fault} failed`);
      expect(saved()).toEqual(["first", "second"]);
      expect(renames.mock.calls.filter(([, target]) => String(target) === file)).toHaveLength(1);
      expect(existsSync(`${file}.claims`)).toBe(fault === "lock release");
    },
  );
});
