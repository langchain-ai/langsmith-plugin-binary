import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { waitFor } from "../test-support/wait.js";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  return spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./fixtures/file-lock-worker.mjs", import.meta.url)),
      moduleUrl,
      mode,
      area.lockPath,
      ...args,
    ],
    {
      env: {
        HOME: area.directory,
        USERPROFILE: area.directory,
        TMPDIR: area.directory,
        TEMP: area.directory,
        TMP: area.directory,
        CI: "1",
      },
      stdio: "ignore",
    },
  );
}

function waitForExit(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.exitCode === 0 && child.signalCode === null);
  return new Promise<boolean>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise(code === 0 && signal === null));
  });
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
  const failed = filesWithPrefix(area, "worker-").find((name) => name.endsWith(".failed"));
  if (failed) throw new Error(readFileSync(join(area.directory, failed), "utf-8"));
  return readdirSync(directory)
    .filter((name) => name.endsWith(FILE_LOCK_CLAIM_EXTENSION))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(directory, name), "utf-8")) as FileLockClaim];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
}

async function replaceClaim(
  sourcePath: string,
  targetPath: string,
  renameFile = rename,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await renameFile(sourcePath, targetPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 7) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
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

it("retries a sharing violation without removing the current claim", async () => {
  const area = createArea();
  const sourcePath = join(area.directory, "claim.next");
  const targetPath = join(area.directory, "claim");
  writeFileSync(sourcePath, "next");
  writeFileSync(targetPath, "current");
  let attempts = 0;
  try {
    await replaceClaim(sourcePath, targetPath, async (source, target) => {
      attempts += 1;
      if (attempts === 1) {
        expect(readFileSync(target, "utf-8")).toBe("current");
        throw Object.assign(new Error("transient sharing violation"), { code: "EPERM" });
      }
      await rename(source, target);
    });
    expect(attempts).toBe(2);
    expect(readFileSync(targetPath, "utf-8")).toBe("next");
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
    await replaceClaim(nextChoosingPath, choosingPath);
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
}, 20_000);

it("lets exactly one of several simultaneous try-acquirers win", async () => {
  for (let trial = 0; trial < 8; trial += 1) {
    const area = createArea();
    const children = new Set<ChildProcess>();
    const ids = Array.from({ length: 4 }, (_, index) => `racer-${index}`);
    const startPath = join(area.directory, "racers.start");
    const gate = join(area.directory, "racers.gate");
    try {
      const racers = ids.map((id) =>
        spawnWorker(area, "race", [join(area.directory, id), gate, "0", id, "", startPath]),
      );
      for (const racer of racers) children.add(racer);
      await waitFor(() => ids.every((id) => filesWithPrefix(area, `${id}.ready`).length > 0));
      writeFileSync(startPath, "go");
      const outcomes = await waitFor(() => {
        const read = ids.map((id) =>
          filesWithPrefix(area, id).includes(id)
            ? readFileSync(join(area.directory, id), "utf-8")
            : "",
        );
        return read.every((outcome) => outcome !== "") ? read : false;
      });
      expect(
        outcomes.filter((outcome) => outcome === "owned"),
        JSON.stringify(outcomes),
      ).toHaveLength(1);
      writeFileSync(gate, "go");
      expect((await Promise.all(racers.map(waitForExit))).every(Boolean)).toBe(true);
    } finally {
      writeFileSync(gate, "go");
      await stopChildren(children);
      cleanupArea(area);
    }
  }
}, 30_000);

function exitedProcessId(): number {
  return Number(
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/process-pid.mjs", import.meta.url))],
      { encoding: "utf8" },
    ).stdout,
  );
}

it("takes over a dead holder's gate exactly once while live and legacy holders contend", async () => {
  for (let trial = 0; trial < 6; trial += 1) {
    const deadPid = exitedProcessId();
    const area = createArea();
    const children = new Set<ChildProcess>();
    const gate = `${area.lockPath}.lock`;
    const startPath = join(area.directory, "gate.start");
    const activePath = join(area.directory, "gate.active");
    mkdirSync(gate);
    writeFileSync(join(gate, "owner"), String(deadPid));
    const ids = Array.from({ length: 8 }, (_, index) => `gate-${index}`);
    try {
      for (const id of ids)
        children.add(
          spawnWorker(area, "gate", [join(area.directory, id), "", "0", id, activePath, startPath]),
        );
      children.add(
        spawn(
          process.execPath,
          [
            fileURLToPath(new URL("./fixtures/file-lock-legacy.mjs", import.meta.url)),
            gate,
            join(area.directory, "legacy"),
            startPath,
            activePath,
          ],
          {
            stdio: "ignore",
          },
        ),
      );
      await waitFor(() =>
        [...ids, "legacy"].every((id) => filesWithPrefix(area, `${id}.ready`).length > 0),
      );
      writeFileSync(startPath, "go");
      await Promise.all([...children].map(waitForExit));
      expect(
        [...ids, "legacy"].map((id) => readFileSync(join(area.directory, id), "utf-8")),
      ).toEqual([...ids, "legacy"].map(() => "ok"));
    } finally {
      await stopChildren(children);
      cleanupArea(area);
    }
  }
}, 60_000);

const claim = (id: string, pid: number) =>
  JSON.stringify({ version: 1, id, pid, choosing: false, ticket: 1 });

it("reclaims an unreadable, foreign or silent claim once it is older than the hold limit", async () => {
  const area = createArea();
  const claimDirectory = `${area.lockPath}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  mkdirSync(claimDirectory);
  const stuck = randomUUID();
  const foreign = randomUUID();
  const entries = {
    [`${randomUUID()}${FILE_LOCK_CLAIM_EXTENSION}`]: "nope",
    [`${stuck}${FILE_LOCK_CLAIM_EXTENSION}`]: claim(stuck, process.pid),
    [`${foreign}${FILE_LOCK_CLAIM_EXTENSION}`]: claim(foreign, 1),
  };
  const old = new Date(Date.now() - 60_000);
  for (const [name, contents] of Object.entries(entries)) {
    writeFileSync(join(claimDirectory, name), contents);
    utimesSync(join(claimDirectory, name), old, old);
  }
  try {
    await expect(withFileLock(area.lockPath, () => "ran", { timeoutMs: 1_000 })).resolves.toBe(
      "ran",
    );
    expect(readdirSync(claimDirectory)).toEqual([]);
  } finally {
    cleanupArea(area);
  }
});

it("keeps a live holder's claim fresh so nobody takes it over", async () => {
  const area = createArea();
  const claimDirectory = `${area.lockPath}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  try {
    await withFileLock(area.lockPath, async () => {
      const [held] = readdirSync(claimDirectory);
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(claimDirectory, held!), old, old);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      await expect(tryAcquireFileLock(area.lockPath)).resolves.toBeUndefined();
    });
  } finally {
    cleanupArea(area);
  }
});

it("waits at least three seconds of silence before taking over a claim", async () => {
  const area = createArea();
  const claimDirectory = `${area.lockPath}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  mkdirSync(claimDirectory);
  const id = randomUUID();
  const path = join(claimDirectory, `${id}${FILE_LOCK_CLAIM_EXTENSION}`);
  writeFileSync(
    path,
    JSON.stringify({ version: 1, id, pid: process.pid, choosing: false, ticket: 1 }),
  );
  const silent = (seconds: number) => {
    const at = new Date(Date.now() - seconds * 1_000);
    utimesSync(path, at, at);
  };
  try {
    silent(2);
    await expect(tryAcquireFileLock(area.lockPath)).resolves.toBeUndefined();
    silent(4);
    const handle = await tryAcquireFileLock(area.lockPath);
    expect(handle).toBeDefined();
    await handle?.release();
  } finally {
    cleanupArea(area);
  }
});
