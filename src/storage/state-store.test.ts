import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withFileLock } from "./file-lock.js";
import type { StateEntries } from "./state-models.js";

type Session = {
  last_line: number;
  turn_count: number;
  updated: string;
  current_turn_run_id?: string;
};
type TracingState = StateEntries<Session>;

const warn = vi.fn();

async function process() {
  vi.resetModules();
  const { createStateStore, pruneStateEntries } = await import("./state-store.js");
  return {
    atomicUpdateState: (path: string, fn: (state: TracingState) => TracingState) =>
      createStateStore<Session>({ path, warn }).update(fn),
    loadState: (path: string) => createStateStore<Session>({ path, warn }).read(),
    pruneStateEntries,
  };
}

let tmpDir: string;
let atomicUpdateState: Awaited<ReturnType<typeof process>>["atomicUpdateState"];
let loadState: Awaited<ReturnType<typeof process>>["loadState"];

const bumpLine = (state: TracingState) => ({
  ...state,
  s1: { ...state.s1!, last_line: state.s1!.last_line + 1 },
});
const bumpInTurn = (state: TracingState) => ({
  ...state,
  s1: { ...state.s1!, last_line: state.s1!.last_line + 1, current_turn_run_id: "turn" },
});
const setLine = (line: number) => (state: TracingState) => ({
  ...state,
  s1: { ...state.s1!, last_line: line },
});
const entry = (updated: string) => ({ last_line: 0, turn_count: 0, updated });

async function holdLock(path: string): Promise<{ release(): Promise<void> }> {
  let release!: () => void;
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withFileLock(path, async () => {
    markAcquired();
    await held;
  });
  await acquired;
  return {
    release: async () => {
      release();
      await holder;
    },
  };
}

function makeStateLockReleaseFail(stateFilePath: string): void {
  const claimDirectory = `${stateFilePath}.claims`;
  const claimName = readdirSync(claimDirectory).find((name) => name.endsWith(".json"));
  if (!claimName) throw new Error("The shared state lock claim is missing");
  const claimPath = join(claimDirectory, claimName);
  unlinkSync(claimPath);
  mkdirSync(claimPath);
}

beforeEach(async () => {
  tmpDir = join(tmpdir(), `state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  warn.mockClear();
  ({ atomicUpdateState, loadState } = await process());
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("read", () => {
  it("returns empty object for non-existent file", () => {
    expect(loadState(join(tmpDir, "missing.json"))).toEqual({});
  });

  it("loads saved state", () => {
    const path = join(tmpDir, "state.json");
    const state = { "session-1": { last_line: 5, turn_count: 2, updated: "2025-01-01T00:00:00Z" } };
    writeFileSync(path, JSON.stringify(state));
    expect(loadState(path)).toEqual(state);
  });

  it("returns empty object for JSON that is not an object of entries", () => {
    const path = join(tmpDir, "list.json");
    writeFileSync(path, "[1, 2]");
    expect(loadState(path)).toEqual({});
  });

  it("returns empty object for malformed JSON and leaves the file alone", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "not json");
    expect(loadState(path)).toEqual({});
    expect(readFileSync(path, "utf-8")).toBe("not json");
  });
});

describe("update", () => {
  it("reads, transforms, and writes state atomically in the same format as before", async () => {
    const path = join(tmpDir, "state.json");
    writeFileSync(path, JSON.stringify({ s1: { last_line: 0, turn_count: 0, updated: "" } }));

    await atomicUpdateState(path, (state) => ({
      ...state,
      s1: { ...state.s1!, last_line: 42 },
    }));

    expect(readFileSync(path, "utf-8")).toBe(
      JSON.stringify({ s1: { last_line: 42, turn_count: 0, updated: "" } }, null, 2),
    );
  });

  it("creates the file if it does not exist", async () => {
    const path = join(tmpDir, "new-state.json");

    await atomicUpdateState(path, (state) => ({
      ...state,
      s1: { last_line: 1, turn_count: 0, updated: "" },
    }));

    expect(loadState(path).s1!.last_line).toBe(1);
  });

  it("serializes concurrent writers so no update is lost", async () => {
    const path = join(tmpDir, "concurrent.json");
    writeFileSync(path, JSON.stringify({ counter: { last_line: 0, turn_count: 0, updated: "" } }));

    const N = 10;
    await Promise.all(
      Array.from({ length: N }, () =>
        atomicUpdateState(path, (state) => ({
          ...state,
          counter: { ...state.counter!, last_line: state.counter!.last_line + 1 },
        })),
      ),
    );

    expect(loadState(path).counter!.last_line).toBe(N);
  });

  it("releases the lock even when the transform throws", async () => {
    const path = join(tmpDir, "throw.json");
    writeFileSync(path, JSON.stringify({ s1: { last_line: 0, turn_count: 0, updated: "" } }));

    await expect(
      atomicUpdateState(path, () => {
        throw new Error("transform error");
      }),
    ).rejects.toThrow("transform error");

    await atomicUpdateState(path, (state) => ({
      ...state,
      s1: { ...state.s1!, last_line: 99 },
    }));
    expect(loadState(path).s1!.last_line).toBe(99);
  });

  it("sets an unreadable file aside, warns, and starts over so tracing continues", async () => {
    const path = join(tmpDir, "corrupt.json");
    writeFileSync(path, "{ half written");

    await atomicUpdateState(path, (state) => ({
      ...state,
      s1: { last_line: 1, turn_count: 0, updated: "" },
    }));

    expect(loadState(path)).toEqual({ s1: { last_line: 1, turn_count: 0, updated: "" } });
    expect(readFileSync(`${path}.corrupt`, "utf-8")).toBe("{ half written");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(".corrupt"));
  });

  it("waits the full time for a held lock only for the first update, then probes briefly", async () => {
    const path = join(tmpDir, "once.json");
    writeFileSync(path, JSON.stringify({ s1: { last_line: 0, turn_count: 0, updated: "" } }));
    const holder = await holdLock(path);

    try {
      const first = Date.now();
      await atomicUpdateState(path, bumpLine);
      expect(Date.now() - first).toBeGreaterThanOrEqual(900);
      const started = Date.now();
      await atomicUpdateState(path, bumpLine);
      await atomicUpdateState(path, bumpLine);
      expect(Date.now() - started).toBeLessThan(900);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("holds the state lock"));
    } finally {
      await holder.release();
    }
  }, 10000);

  it("keeps an update made while another process holds the lock and merges it for the next holder", async () => {
    const path = join(tmpDir, "kept.json");
    writeFileSync(path, JSON.stringify({ s1: { last_line: 3, turn_count: 1, updated: "" } }));
    const holder = await holdLock(path);

    try {
      const started = Date.now();
      await atomicUpdateState(path, bumpInTurn);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(JSON.parse(readFileSync(path, "utf-8")).s1.last_line).toBe(3);
      expect(loadState(path).s1).toMatchObject({ last_line: 4, current_turn_run_id: "turn" });
    } finally {
      await holder.release();
    }

    const next = await process();
    await next.atomicUpdateState(path, (state) => bumpInTurn(state));
    expect(JSON.parse(readFileSync(path, "utf-8")).s1).toMatchObject({
      last_line: 5,
      current_turn_run_id: "turn",
    });
    expect(existsSync(`${path}.pending`)).toBe(false);
  }, 15000);

  it("lets later processes probe briefly once an update is pending, and merges every update in order", async () => {
    const path = join(tmpDir, "ordered.json");
    writeFileSync(path, JSON.stringify({ s1: { last_line: 0, turn_count: 0, updated: "" } }));
    const holder = await holdLock(path);

    try {
      await atomicUpdateState(path, setLine(1));
      const second = await process();
      const started = Date.now();
      await second.atomicUpdateState(path, setLine(2));
      expect(Date.now() - started).toBeLessThan(800);
      expect(second.loadState(path).s1!.last_line).toBe(2);
    } finally {
      await holder.release();
    }

    const third = await process();
    await third.atomicUpdateState(path, setLine(3));
    expect(JSON.parse(readFileSync(path, "utf-8")).s1.last_line).toBe(3);
    expect(readdirSync(tmpDir).toSorted()).toEqual(["ordered.json", "ordered.json.claims"]);
  }, 15000);

  it("merges updates saved back to back in one process in the order they were made", async () => {
    const path = join(tmpDir, "sequence.json");
    writeFileSync(path, JSON.stringify({ s1: { last_line: 0, turn_count: 0, updated: "" } }));
    const holder = await holdLock(path);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    try {
      for (let line = 1; line <= 8; line++) {
        await atomicUpdateState(path, (state) => ({
          ...state,
          s1: { ...state.s1!, last_line: line },
        }));
      }
    } finally {
      vi.useRealTimers();
      await holder.release();
    }
    await (await process()).atomicUpdateState(path, (state) => state);
    expect(JSON.parse(readFileSync(path, "utf-8")).s1.last_line).toBe(8);
  }, 15000);

  it("keeps every update across 20 turns, some made under a held lock, and leaves no extra files", async () => {
    const path = join(tmpDir, "turns.json");
    writeFileSync(path, JSON.stringify({ s1: { last_line: 0, turn_count: 0, updated: "" } }));
    for (let turn = 0; turn < 20; turn++) {
      const hooks = await process();
      const holder = turn >= 5 && turn < 8 ? await holdLock(path) : undefined;
      try {
        for (let update = 0; update < 3; update++) await hooks.atomicUpdateState(path, bumpLine);
      } finally {
        await holder?.release();
      }
      expect(hooks.loadState(path).s1!.last_line).toBe((turn + 1) * 3);
    }
    await (await process()).atomicUpdateState(path, (state) => state);

    expect(JSON.parse(readFileSync(path, "utf-8")).s1.last_line).toBe(60);
    expect(readdirSync(tmpDir).toSorted()).toEqual(["turns.json", "turns.json.claims"]);
  }, 60000);

  it("ignores a half-written pending file and sweeps it once abandoned", async () => {
    const path = join(tmpDir, "crashed.json");
    writeFileSync(path, JSON.stringify({ s1: { last_line: 7, turn_count: 0, updated: "" } }));
    mkdirSync(`${path}.pending`);
    const partial = join(`${path}.pending`, "0000000000001-1-x.pending.tmp");
    writeFileSync(partial, '[{"session":"s1","set":');
    expect(loadState(path).s1!.last_line).toBe(7);
    utimesSync(partial, new Date(0), new Date(0));

    await atomicUpdateState(path, (state) => state);

    expect(existsSync(`${path}.pending`)).toBe(false);
  });

  it("preserves a state write error when shared lock cleanup also fails", async () => {
    const path = join(tmpDir, "write-error.json");
    writeFileSync(path, JSON.stringify({ s1: { last_line: 3, turn_count: 1, updated: "" } }));
    let writeError: unknown;

    try {
      await atomicUpdateState(path, (state) => {
        makeStateLockReleaseFail(path);
        rmSync(path);
        mkdirSync(path);
        return { ...state, s1: { ...state.s1!, last_line: 99 } };
      });
    } catch (error) {
      writeError = error;
    }

    expect(writeError).toBeInstanceOf(Error);
    expect((writeError as NodeJS.ErrnoException).code).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not release"));
  });

  it("warns but succeeds when lock cleanup fails after state is written", async () => {
    const path = join(tmpDir, "committed.json");
    writeFileSync(path, JSON.stringify({ counter: { last_line: 0, turn_count: 0, updated: "" } }));
    let mutationCalls = 0;

    await expect(
      atomicUpdateState(path, (state) => {
        mutationCalls++;
        makeStateLockReleaseFail(path);
        return {
          ...state,
          counter: { ...state.counter!, last_line: state.counter!.last_line + 1 },
        };
      }),
    ).resolves.toBeUndefined();
    expect(mutationCalls).toBe(1);
    expect(loadState(path).counter!.last_line).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not release"));
  });
});

describe("pruneStateEntries", () => {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const twoDaysAgo = new Date(now - 2 * dayMs).toISOString();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();

  it("removes entries older than the given age or with no time, and keeps the rest", async () => {
    const { pruneStateEntries } = await process();
    const state: TracingState = JSON.parse(
      JSON.stringify({
        old: entry(twoDaysAgo),
        noTimestamp: entry(""),
        recent: entry(oneHourAgo),
      }).replace("{", `{"__proto__":${JSON.stringify(entry(oneHourAgo))},`),
    );
    state.atCutoff = entry(new Date(now - dayMs).toISOString());
    const result = pruneStateEntries(state, dayMs, now);
    expect(Object.keys(result).toSorted()).toEqual(["__proto__", "atCutoff", "recent"]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
