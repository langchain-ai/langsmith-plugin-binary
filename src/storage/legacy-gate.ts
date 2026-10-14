import { lstat, mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  FILE_LOCK_COMPATIBLE_ABANDONED_GATE_MS,
  FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE,
  FILE_LOCK_COMPATIBLE_OWNER_FILE,
  FILE_LOCK_COMPATIBLE_OWNER_MESSAGE,
  FILE_LOCK_COMPATIBLE_OWNER_PID_PATTERN,
  FILE_LOCK_COMPATIBLE_STALE_SUFFIX,
  FILE_LOCK_DIRECTORY_CONTENTION_CODES,
  FILE_LOCK_DIRECTORY_MODE,
  FILE_LOCK_ENCODING,
  FILE_LOCK_EXCLUSIVE_FLAG,
  FILE_LOCK_FILE_MODE,
  FILE_LOCK_GATE_CLEANUP_WARNING,
  FILE_LOCK_LEGACY_DIRECTORY_SUFFIX,
  FILE_LOCK_STALE_CLAIM_MS,
  FILE_LOCK_STALE_GATE_CLEANUP_WARNING,
} from "./constants.js";
import type {
  LegacyDirectoryFileLockGate,
  LegacyGateAttempt,
  TryAcquireFileLock,
} from "./models.js";
import { startHeartbeat, stopHeartbeat } from "./file-lock-heartbeat.js";
import {
  isBusyFileError,
  processIsAlive,
  removeFile,
  waitForNextScan,
} from "./file-lock-support.js";
import { FileLockTimeoutError } from "./errors.js";
import { errorCode } from "../utils/errors.js";
import { removeDirectoryBestEffort } from "../utils/files/cleanup.js";
import { FILE_EXISTS_CODE, FILE_MISSING_CODE } from "../utils/constants.js";

async function createLegacyGate(gatePath: string): Promise<LegacyDirectoryFileLockGate> {
  await mkdir(gatePath, { mode: FILE_LOCK_DIRECTORY_MODE });
  const stat = await lstat(gatePath);
  if (!stat.isDirectory()) throw new Error(FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE);
  await recordLegacyGateOwner(gatePath);
  startHeartbeat(join(gatePath, FILE_LOCK_COMPATIBLE_OWNER_FILE), gatePath);
  return { path: gatePath, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

async function waitOutContention(attempt: LegacyGateAttempt, error: unknown): Promise<void> {
  const { gatePath, filePath, deadline, tryAcquire } = attempt;
  const code = errorCode(error);
  const permissionDenied = FILE_LOCK_DIRECTORY_CONTENTION_CODES.includes(code ?? "");
  if (code !== FILE_EXISTS_CODE && !permissionDenied) throw error;
  let isContended = false;
  try {
    const gate = await lstat(gatePath);
    const isDirectory = gate.isDirectory();
    isContended = isDirectory || (gate.isFile() && code === FILE_EXISTS_CODE);
    if (isContended && (await legacyGateIsAbandoned(gatePath, isDirectory, gate.mtimeMs))) {
      if (!(await reclaimLegacyGate(gatePath, filePath, tryAcquire)))
        await waitForNextScan(deadline, gatePath);
      return;
    }
  } catch (statError) {
    if (errorCode(statError) === FILE_MISSING_CODE) {
      if (code === FILE_EXISTS_CODE) {
        attempt.retriedMissingPermission = false;
        await waitForNextScan(deadline, gatePath);
        return;
      }
      if (permissionDenied && !attempt.retriedMissingPermission) {
        attempt.retriedMissingPermission = true;
        return;
      }
    }
    throw error;
  }
  if (!isContended) throw error;
  attempt.retriedMissingPermission = false;
  await waitForNextScan(deadline, gatePath);
}

export async function acquireLegacyDirectoryGate(
  filePath: string,
  deadline: number,
  tryAcquire: TryAcquireFileLock,
): Promise<LegacyDirectoryFileLockGate> {
  const gatePath = `${filePath}${FILE_LOCK_LEGACY_DIRECTORY_SUFFIX}`;
  await mkdir(dirname(filePath), { recursive: true, mode: FILE_LOCK_DIRECTORY_MODE });
  const attempt: LegacyGateAttempt = {
    gatePath,
    filePath,
    deadline,
    tryAcquire,
    retriedMissingPermission: false,
  };
  for (;;) {
    if (performance.now() >= deadline) throw new FileLockTimeoutError(gatePath);
    try {
      return await createLegacyGate(gatePath);
    } catch (error) {
      await waitOutContention(attempt, error);
    }
  }
}

export async function releaseLegacyDirectoryGate(gate: LegacyDirectoryFileLockGate): Promise<void> {
  stopHeartbeat(gate.path);
  let stat;
  try {
    stat = await lstat(gate.path);
  } catch (error) {
    if (errorCode(error) === FILE_MISSING_CODE) return;
    throw error;
  }
  if (
    !stat.isDirectory() ||
    stat.dev !== gate.dev ||
    stat.ino !== gate.ino ||
    stat.birthtimeMs !== gate.birthtimeMs
  ) {
    throw new Error(FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE);
  }
  await removeFile(join(gate.path, FILE_LOCK_COMPATIBLE_OWNER_FILE));
  await rmdir(gate.path);
}

async function recordLegacyGateOwner(gatePath: string): Promise<void> {
  try {
    await writeFile(join(gatePath, FILE_LOCK_COMPATIBLE_OWNER_FILE), String(process.pid), {
      flag: FILE_LOCK_EXCLUSIVE_FLAG,
      mode: FILE_LOCK_FILE_MODE,
    });
  } catch (error) {
    await removeDirectoryBestEffort(gatePath, FILE_LOCK_GATE_CLEANUP_WARNING);
    throw new Error(FILE_LOCK_COMPATIBLE_OWNER_MESSAGE, { cause: error });
  }
}

async function legacyGateIsAbandoned(
  gatePath: string,
  isDirectory: boolean,
  modifiedAtMs: number,
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(
      isDirectory ? join(gatePath, FILE_LOCK_COMPATIBLE_OWNER_FILE) : gatePath,
      FILE_LOCK_ENCODING,
    );
  } catch (error) {
    if (errorCode(error) !== FILE_MISSING_CODE) return false;
    contents = "";
  }
  const pid = FILE_LOCK_COMPATIBLE_OWNER_PID_PATTERN.test(contents.trim())
    ? Number(contents.trim())
    : undefined;
  if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0)
    return (
      processIsAlive(pid) === false || (isDirectory && (await ownerHeartbeatStopped(gatePath)))
    );
  return !isDirectory && Date.now() - modifiedAtMs >= FILE_LOCK_COMPATIBLE_ABANDONED_GATE_MS;
}

async function ownerHeartbeatStopped(gatePath: string): Promise<boolean> {
  try {
    const owner = await lstat(join(gatePath, FILE_LOCK_COMPATIBLE_OWNER_FILE));
    return Date.now() - owner.mtimeMs >= FILE_LOCK_STALE_CLAIM_MS;
  } catch {
    return false;
  }
}

async function reclaimLegacyGate(
  gatePath: string,
  filePath: string,
  tryAcquire: TryAcquireFileLock,
): Promise<boolean> {
  const takeover = await tryAcquire(filePath);
  if (!takeover) return false;
  try {
    let gate;
    try {
      gate = await lstat(gatePath);
    } catch (error) {
      if (errorCode(error) === FILE_MISSING_CODE) return true;
      throw error;
    }
    const isDirectory = gate.isDirectory();
    if (!(await legacyGateIsAbandoned(gatePath, isDirectory, gate.mtimeMs))) return false;
    const stalePath = `${gatePath}.${randomUUID()}${FILE_LOCK_COMPATIBLE_STALE_SUFFIX}`;
    try {
      await rename(gatePath, stalePath);
    } catch (error) {
      if (isBusyFileError(error)) return false;
      throw error;
    }
    if (!isDirectory) {
      await removeFile(stalePath);
      return true;
    }
    await removeFile(join(stalePath, FILE_LOCK_COMPATIBLE_OWNER_FILE));
    await removeDirectoryBestEffort(stalePath, FILE_LOCK_STALE_GATE_CLEANUP_WARNING);
    return true;
  } finally {
    await takeover.release();
  }
}
