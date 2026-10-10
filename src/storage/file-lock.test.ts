import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { tryAcquireFileLock, withFileLock } from "./file-lock.js";
import {
  FILE_LOCK_CLAIM_EXTENSION,
  FILE_LOCK_DIRECTORY_SUFFIX,
  FILE_LOCK_FILE_MODE,
  FILE_LOCK_TEMP_PREFIX,
  FILE_LOCK_TEMP_SUFFIX,
} from "./constants.js";
import type { FileLockClaim } from "./models.js";

const childProgram = `
const { existsSync, mkdirSync, rmdirSync, writeFileSync } = await import("node:fs");
const { setTimeout: delay } = await import("node:timers/promises");
const api = await import(process.argv[1]);
const [mode, lockPath, marker, gate, timeout, id, activePath, startPath] = process.argv.slice(2);
if (mode === "hold") {
  await api.withFileLock(lockPath, async () => {
    writeFileSync(marker, "held");
    while (!existsSync(gate)) await delay(5);
  }, { timeoutMs: Number(timeout) });
} else if (mode === "timeout") {
  try {
    await api.withFileLock(lockPath, async () => writeFileSync(marker, "ran"), { timeoutMs: Number(timeout) });
    process.exitCode = 2;
  } catch (error) {
    process.exitCode = String(error).includes("Timed out waiting for file lock") ? 0 : 3;
  }
} else if (mode === "try") {
  const handle = await api.tryAcquireFileLock(lockPath);
  writeFileSync(marker, handle ? "owned" : "busy");
  if (handle) await handle.release();
} else if (mode === "queue") {
  writeFileSync(marker + ".ready", "ready");
  while (startPath && !existsSync(startPath)) await delay(5);
  try {
    await api.withFileLock(lockPath, async () => {
      try {
        mkdirSync(activePath);
      } catch {
        writeFileSync(marker + ".violation", "overlap");
        throw new Error("overlapping critical sections");
      }
      writeFileSync(marker + ".acquired", "acquired");
      while (!existsSync(gate)) await delay(5);
      rmdirSync(activePath);
      writeFileSync(marker + ".complete", "complete");
    }, { timeoutMs: Number(timeout) });
    writeFileSync(marker + ".released", "released");
  } catch {
    process.exitCode = 4;
  }
} else if (mode === "die") {
  const handle = await api.tryAcquireFileLock(lockPath);
  if (!handle) process.exit(5);
  writeFileSync(marker, "owned");
  for (;;) await delay(1000);
}
`;

function createArea() {
  const directory = mkdtempSync(join(tmpdir(), "plugins-base-file-lock-"));
  return { directory, lockPath: join(directory, "state.lock") };
}

function spawnWorker(
  area: ReturnType<typeof createArea>,
  mode: string,
  args: string[] = [],
): ChildProcess {
  const moduleUrl = pathToFileURL(resolve("dist/storage/file-lock.js")).href;
  return spawn(process.execPath, ["-e", childProgram, moduleUrl, mode, area.lockPath, ...args], {
    env: { HOME: area.directory, TMPDIR: area.directory, CI: "1" },
    stdio: "ignore",
  });
}

function waitForExit(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.exitCode === 0 && child.signalCode === null);
  return new Promise<boolean>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise(code === 0 && signal === null));
  });
}

async function waitFor<T>(predicate: () => T | false): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Timed out waiting for lock test process state");
}

function cleanupArea(area: ReturnType<typeof createArea>): void {
  for (const entry of readdirSync(area.directory, { withFileTypes: true })) {
    const entryPath = join(area.directory, entry.name);
    if (entry.isDirectory()) {
      for (const nested of readdirSync(entryPath)) unlinkSync(join(entryPath, nested));
      rmdirSync(entryPath);
    } else {
      unlinkSync(entryPath);
    }
  }
  rmdirSync(area.directory);
}

function filesWithPrefix(area: ReturnType<typeof createArea>, prefix: string): string[] {
  return readdirSync(area.directory).filter((name) => name.startsWith(prefix));
}

function readClaims(area: ReturnType<typeof createArea>): FileLockClaim[] {
  const directory = `${area.lockPath}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  return readdirSync(directory)
    .filter((name) => name.endsWith(FILE_LOCK_CLAIM_EXTENSION))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf-8")));
}

it("rejects a zero timeout before creating lock state", async () => {
  const area = createArea();
  try {
    await expect(withFileLock(area.lockPath, () => undefined, { timeoutMs: 0 })).rejects.toThrow(
      "timeoutMs must be a finite positive number",
    );
    expect(filesWithPrefix(area, "state.lock.claims")).toHaveLength(0);
  } finally {
    cleanupArea(area);
  }
});

it("rejects a symlinked claims directory without changing its target", async () => {
  const area = createArea();
  const target = join(area.directory, "unrelated");
  const claimDirectory = `${area.lockPath}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  mkdirSync(target, { mode: 0o755 });
  symlinkSync(target, claimDirectory);
  const modeBefore = statSync(target).mode & 0o777;
  try {
    await expect(tryAcquireFileLock(area.lockPath)).rejects.toThrow(
      "Unsafe file lock claims directory",
    );
    expect(statSync(target).mode & 0o777).toBe(modeBefore);
    expect(readdirSync(target)).toHaveLength(0);
  } finally {
    cleanupArea(area);
  }
});

async function stopChildren(children: Set<ChildProcess>): Promise<void> {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(
    [...children].map((child) =>
      child.exitCode === null && child.signalCode === null
        ? waitForExit(child).catch(() => undefined)
        : undefined,
    ),
  );
}

async function releaseQueue(
  area: ReturnType<typeof createArea>,
  children: ChildProcess[],
  ids: string[],
): Promise<void> {
  const released = new Set<string>();
  while (released.size < ids.length) {
    const id = await waitFor(
      () =>
        ids.find(
          (candidate) =>
            filesWithPrefix(area, `${candidate}.complete`).length === 0 &&
            filesWithPrefix(area, `${candidate}.acquired`).length > 0 &&
            !released.has(candidate),
        ) ?? false,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const waiting = ids.filter(
      (candidate) =>
        filesWithPrefix(area, `${candidate}.complete`).length === 0 &&
        filesWithPrefix(area, `${candidate}.acquired`).length > 0 &&
        !released.has(candidate),
    );
    expect(waiting).toEqual([id]);
    writeFileSync(join(area.directory, `${id}.gate`), "go");
    await waitFor(() => filesWithPrefix(area, `${id}.complete`).length > 0);
    released.add(id);
  }
  const results = await Promise.all(children.map(waitForExit));
  expect(results.every(Boolean)).toBe(true);
  expect(filesWithPrefix(area, "worker-").some((name) => name.endsWith(".violation"))).toBe(false);
}

async function startQueueWorkers(
  area: ReturnType<typeof createArea>,
  children: Set<ChildProcess>,
  count: number,
): Promise<{ ids: string[]; workers: ChildProcess[] }> {
  const ids = Array.from({ length: count }, (_, index) => `worker-${index}`);
  const startPath = join(area.directory, "workers.start");
  const activePath = join(area.directory, "critical-section");
  const workers = ids.map((id) =>
    spawnWorker(area, "queue", [
      join(area.directory, id),
      join(area.directory, `${id}.gate`),
      "10000",
      id,
      activePath,
      startPath,
    ]),
  );
  for (const worker of workers) children.add(worker);
  await waitFor(() => ids.every((id) => filesWithPrefix(area, `${id}.ready`).length > 0));
  writeFileSync(startPath, "go");
  return { ids, workers };
}

async function startHolder(
  area: ReturnType<typeof createArea>,
  children: Set<ChildProcess>,
): Promise<ChildProcess> {
  const holder = spawnWorker(area, "hold", [
    join(area.directory, "holder.entered"),
    join(area.directory, "holder.gate"),
    "5000",
  ]);
  children.add(holder);
  await waitFor(() => filesWithPrefix(area, "holder.entered").length > 0);
  return holder;
}

it("times out before running the callback while another process owns the lock", async () => {
  const area = createArea();
  const children = new Set<ChildProcess>();
  try {
    await startHolder(area, children);
    const callback = join(area.directory, "timeout.callback");
    const contender = spawnWorker(area, "timeout", [callback, "", "75"]);
    children.add(contender);
    expect(await waitForExit(contender)).toBe(true);
    expect(filesWithPrefix(area, "timeout.callback")).toHaveLength(0);
  } finally {
    writeFileSync(join(area.directory, "holder.gate"), "go");
    await stopChildren(children);
    cleanupArea(area);
  }
});

it("keeps a live owner claim after another process fails try-acquire", async () => {
  const area = createArea();
  const children = new Set<ChildProcess>();
  try {
    const holder = await startHolder(area, children);
    const failedAttempt = join(area.directory, "try.failed");
    const first = spawnWorker(area, "try", [failedAttempt]);
    children.add(first);
    expect(await waitForExit(first)).toBe(true);
    expect(readFileSync(failedAttempt, "utf-8")).toBe("busy");
    expect(readClaims(area)).toHaveLength(1);
    const whileHeld = join(area.directory, "try.while-held");
    const second = spawnWorker(area, "try", [whileHeld]);
    children.add(second);
    expect(await waitForExit(second)).toBe(true);
    expect(readFileSync(whileHeld, "utf-8")).toBe("busy");
    writeFileSync(join(area.directory, "holder.gate"), "go");
    expect(await waitForExit(holder)).toBe(true);
    const afterRelease = join(area.directory, "try.after-release");
    const third = spawnWorker(area, "try", [afterRelease]);
    children.add(third);
    expect(await waitForExit(third)).toBe(true);
    expect(readFileSync(afterRelease, "utf-8")).toBe("owned");
  } finally {
    writeFileSync(join(area.directory, "holder.gate"), "go");
    await stopChildren(children);
    cleanupArea(area);
  }
});

it("waits through a live choosing peer and serializes separate contenders", async () => {
  const area = createArea();
  const children = new Set<ChildProcess>();
  const claimDirectory = `${area.lockPath}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  mkdirSync(claimDirectory);
  const choosingId = randomUUID();
  const choosingPath = join(claimDirectory, `${choosingId}${FILE_LOCK_CLAIM_EXTENSION}`);
  writeFileSync(
    choosingPath,
    JSON.stringify({ version: 1, id: choosingId, pid: process.pid, choosing: true, ticket: 0 }),
    { mode: FILE_LOCK_FILE_MODE },
  );
  try {
    const { ids, workers } = await startQueueWorkers(area, children, 6);
    await waitFor(
      () => readClaims(area).filter((claim) => claim.id !== choosingId).length === ids.length,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    expect(
      filesWithPrefix(area, "worker-").filter((name) => name.endsWith(".acquired")),
    ).toHaveLength(0);
    const maxTicket = Math.max(
      ...readClaims(area)
        .filter((claim) => claim.id !== choosingId)
        .map((claim) => claim.ticket),
    );
    const nextChoosingPath = join(
      claimDirectory,
      `${FILE_LOCK_TEMP_PREFIX}${choosingId}${FILE_LOCK_TEMP_SUFFIX}`,
    );
    writeFileSync(
      nextChoosingPath,
      JSON.stringify({
        version: 1,
        id: choosingId,
        pid: process.pid,
        choosing: false,
        ticket: maxTicket + 1,
      }),
      { mode: FILE_LOCK_FILE_MODE },
    );
    renameSync(nextChoosingPath, choosingPath);
    await releaseQueue(area, workers, ids);
  } finally {
    await stopChildren(children);
    try {
      unlinkSync(choosingPath);
    } catch {}
    cleanupArea(area);
  }
});

it("reclaims a killed owner while fresh processes contend", async () => {
  const area = createArea();
  const children = new Set<ChildProcess>();
  const deadOwner = spawnWorker(area, "die", [join(area.directory, "dead-owner.entered")]);
  children.add(deadOwner);
  try {
    await waitFor(() => filesWithPrefix(area, "dead-owner.entered").length > 0);
    deadOwner.kill("SIGKILL");
    await waitForExit(deadOwner);
    const { ids, workers } = await startQueueWorkers(area, children, 5);
    await waitFor(() =>
      filesWithPrefix(area, "worker-").some((name) => name.endsWith(".acquired")),
    );
    await releaseQueue(area, workers, ids);
  } finally {
    await stopChildren(children);
    cleanupArea(area);
  }
});
