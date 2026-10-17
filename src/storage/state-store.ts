import { readFileSync, renameSync } from "node:fs";
import { publishByRename } from "../utils/files/publish.js";
import { isPlainRecord } from "../utils/validation/objects.js";
import { FileLockTimeoutError } from "./errors.js";
import { acquireCompatibleDirectoryFileLock } from "./file-lock.js";
import type { FileLockHandle } from "./models.js";
import {
  STATE_CORRUPT_SUFFIX,
  STATE_CORRUPT_WARNING,
  STATE_FILE_ENCODING,
  STATE_LOCK_BUSY_WARNING,
  STATE_LOCK_PROBE_MS,
  STATE_LOCK_RELEASE_WARNING,
  STATE_LOCK_WAIT_MS,
  STATE_PRIVATE_FILE_MODE,
  STATE_TEMP_SUFFIX,
} from "./state-constants.js";
import type {
  StateEntries,
  StateEntryWithUpdated,
  StateStore,
  StateStoreOptions,
} from "./state-models.js";
import {
  applyPatches,
  diffState,
  hasRecentPending,
  readPending,
  removePending,
  writePending,
} from "./state-pending.js";

export function createStateStore<T>(options: StateStoreOptions): StateStore<T> {
  const { path } = options;
  const warn = options.warn ?? console.warn;

  function read(): StateEntries<T> {
    const { patches } = readPending(path);
    return applyPatches(readStateFile<T>(path), patches);
  }

  async function update(fn: (state: StateEntries<T>) => StateEntries<T>): Promise<void> {
    const waitMs = hasRecentPending(path) ? STATE_LOCK_PROBE_MS : STATE_LOCK_WAIT_MS;
    const ran = await withStateFileLock(
      path,
      warn,
      () => {
        const { files, patches } = readPending(path);
        const current = readStateFile<T>(path, () => setAsideCorruptState(path, warn));
        publishState(path, fn(applyPatches(current, patches)));
        removePending(path, files);
      },
      waitMs,
    );
    if (ran) return;
    const before = read();
    writePending(path, diffState(before, fn(before)));
  }

  return { read, update };
}

export function pruneStateEntries<T extends StateEntryWithUpdated>(
  state: StateEntries<T>,
  maxAgeMs: number,
  now: number = Date.now(),
): StateEntries<T> {
  const cutoff = now - maxAgeMs;
  const pruned: StateEntries<T> = {};
  for (const [id, entry] of Object.entries(state)) {
    const updatedMs = entry.updated ? new Date(entry.updated).getTime() : 0;
    if (updatedMs >= cutoff) {
      Object.defineProperty(pruned, id, {
        value: entry,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return pruned;
}

function readStateFile<T>(path: string, onUnparseable?: () => void): StateEntries<T> {
  let raw: string;
  try {
    raw = readFileSync(path, STATE_FILE_ENCODING);
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainRecord(parsed) ? (parsed as StateEntries<T>) : {};
  } catch {
    onUnparseable?.();
    return {};
  }
}

function setAsideCorruptState(path: string, warn: (message: string) => void): void {
  try {
    renameSync(path, `${path}${STATE_CORRUPT_SUFFIX}`);
  } catch {}
  warn(STATE_CORRUPT_WARNING);
}

function publishState<T>(path: string, state: StateEntries<T>): void {
  publishByRename(path, JSON.stringify(state, null, 2), STATE_TEMP_SUFFIX, STATE_PRIVATE_FILE_MODE);
}

async function withStateFileLock(
  path: string,
  warn: (message: string) => void,
  callback: () => void | Promise<void>,
  waitMs: number,
): Promise<boolean> {
  let lock: FileLockHandle;
  try {
    lock = await acquireCompatibleDirectoryFileLock(path, { timeoutMs: waitMs });
  } catch (error) {
    if (!(error instanceof FileLockTimeoutError)) throw error;
    warn(STATE_LOCK_BUSY_WARNING);
    return false;
  }
  try {
    await callback();
  } finally {
    try {
      await lock.release();
    } catch (error) {
      warn(`${STATE_LOCK_RELEASE_WARNING}: ${error}`);
    }
  }
  return true;
}
