import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { removeEmptyLockFolders } from "../storage/lock-folders.js";
import { acquireCompatibleDirectoryFileLock } from "../storage/file-lock.js";
import { FILE_LOCK_DIRECTORY_SUFFIX } from "../storage/constants.js";
import { FileLockTimeoutError } from "../storage/errors.js";
import { describe, errorCode } from "../utils/errors.js";
import {
  POLICY_ASYNC_UPDATE_MESSAGE,
  POLICY_CANNOT_READ_PREFIX,
  POLICY_DIRECTORY_CLOSE_WARNING,
  POLICY_DIRECTORY_OPEN_FLAG,
  POLICY_DURABILITY_WARNING,
  POLICY_FILE_ENCODING,
  POLICY_FILE_MODE,
  POLICY_LOCK_CLEANUP_FAILED_PREFIX,
  POLICY_LOCK_RELEASE_WARNING,
  POLICY_LOCK_TIMEOUT_ERROR,
  POLICY_LOCK_TIMEOUT_MESSAGE,
  POLICY_LOCK_TIMEOUT_MS,
  POLICY_NOT_REGULAR_MESSAGE,
  POLICY_PARSE_RESULT_MESSAGE,
  POLICY_TEMP_CLEANUP_WARNING,
  POLICY_TEMP_CLOSE_WARNING,
  POLICY_TEMP_CREATE_FLAG,
  POLICY_UNREADABLE_MESSAGE,
  POLICY_WARNING_SEPARATOR,
} from "./constants.js";
import type { PolicyFileOptions, PolicyUpdateResult } from "./models.js";
import { FILE_MISSING_CODE, WINDOWS_PLATFORM } from "../utils/constants.js";

export function readPolicyFile<T>(path: string, options: PolicyFileOptions<T>): T {
  let raw: string;
  try {
    if (options.requireRegularFile && !lstatSync(path).isFile())
      throw new Error(POLICY_NOT_REGULAR_MESSAGE);
    raw = readFileSync(path, POLICY_FILE_ENCODING);
  } catch (error) {
    if (errorCode(error) === FILE_MISSING_CODE) {
      try {
        lstatSync(path);
      } catch (statError) {
        if (errorCode(statError) === FILE_MISSING_CODE) return options.empty();
        throw statError;
      }
    }
    throw error;
  }
  const policy = options.parse(JSON.parse(raw));
  if (policy === undefined) throw new TypeError(POLICY_PARSE_RESULT_MESSAGE);
  return policy;
}

export async function updatePolicyFile<T>(
  path: string,
  options: PolicyFileOptions<T>,
  update: (policy: T) => T | void | Promise<void>,
): Promise<PolicyUpdateResult> {
  const lockPath = `${path}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  const lock = await acquirePolicyLock(path);
  const warnings: string[] = [];
  try {
    const policy = readPolicyForUpdate(path, options);
    const updated = update(policy);
    if (isThenable(updated)) throw new TypeError(POLICY_ASYNC_UPDATE_MESSAGE);
    await replacePolicyFile(path, updated === undefined ? policy : updated, warnings);
    if (process.platform !== WINDOWS_PLATFORM) await syncPolicyDirectory(path, warnings);
  } finally {
    await bestEffort(
      warnings,
      async () => {
        await lock.release();
        await removeEmptyLockFolders(path, dirname(path));
      },
      `${POLICY_LOCK_CLEANUP_FAILED_PREFIX} ${lockPath}. ${POLICY_LOCK_RELEASE_WARNING}`,
    );
  }
  return warnings.length ? { warning: warnings.join(POLICY_WARNING_SEPARATOR) } : {};
}

async function bestEffort(
  warnings: string[],
  action: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    warnings.push(`${message}: ${describe(error)}`);
  }
}

function acquirePolicyLock(path: string) {
  return acquireCompatibleDirectoryFileLock(path, {
    timeoutMs: POLICY_LOCK_TIMEOUT_MS,
  }).catch((error) => {
    const timeout = findLockTimeout(error);
    if (timeout !== undefined) {
      throw new Error(
        `${POLICY_LOCK_TIMEOUT_ERROR} ${timeout.blockedPath}. ${POLICY_LOCK_TIMEOUT_MESSAGE}`,
        { cause: error },
      );
    }
    throw error;
  });
}

function readPolicyForUpdate<T>(path: string, options: PolicyFileOptions<T>): T {
  try {
    return readPolicyFile(path, options);
  } catch (error) {
    throw new Error(`${POLICY_CANNOT_READ_PREFIX} ${path}. ${POLICY_UNREADABLE_MESSAGE}`, {
      cause: error,
    });
  }
}

async function writePolicyTemp<T>(tempPath: string, policy: T, warnings: string[]): Promise<void> {
  const temp = await open(tempPath, POLICY_TEMP_CREATE_FLAG, POLICY_FILE_MODE);
  try {
    await temp.writeFile(`${JSON.stringify(policy)}\n`, POLICY_FILE_ENCODING);
    await temp.sync();
  } catch (error) {
    await bestEffort(warnings, () => temp.close(), POLICY_TEMP_CLOSE_WARNING);
    throw error;
  }
  await temp.close();
}

async function replacePolicyFile<T>(path: string, policy: T, warnings: string[]): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writePolicyTemp(tempPath, policy, warnings);
    await rename(tempPath, path);
  } catch (error) {
    await bestEffort(warnings, () => unlink(tempPath), POLICY_TEMP_CLEANUP_WARNING);
    throw error;
  }
}

async function syncPolicyDirectory(path: string, warnings: string[]): Promise<void> {
  await bestEffort(
    warnings,
    async () => {
      const directory = await open(dirname(path), POLICY_DIRECTORY_OPEN_FLAG);
      try {
        await directory.sync();
      } finally {
        await bestEffort(warnings, () => directory.close(), POLICY_DIRECTORY_CLOSE_WARNING);
      }
    },
    POLICY_DURABILITY_WARNING,
  );
}

function isThenable(value: unknown): boolean {
  return typeof Reflect.get(Object(value), "then") === "function";
}

function findLockTimeout(error: unknown): FileLockTimeoutError | undefined {
  if (error instanceof FileLockTimeoutError) return error;
  if (!(error instanceof AggregateError)) return undefined;
  return error.errors.map(findLockTimeout).find((found) => found !== undefined);
}
