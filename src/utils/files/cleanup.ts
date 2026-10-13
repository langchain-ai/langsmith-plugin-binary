import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CLEANUP_IGNORED_DIRECTORY_CODES, CLEANUP_MISSING_CODE } from "./cleanup-constants.js";

export async function removeFileIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (errorCode(error) === CLEANUP_MISSING_CODE) return false;
    throw error;
  }
}

export async function removeEmptyDirectories(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await rmdir(path);
    } catch (error) {
      const code = errorCode(error);
      if (!CLEANUP_IGNORED_DIRECTORY_CODES.some((ignored) => ignored === code)) throw error;
    }
  }
}

export async function removeStaleFiles(
  directory: string,
  pattern: RegExp,
  modifiedBeforeMs: number,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (errorCode(error) === CLEANUP_MISSING_CODE) return;
    throw error;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (info.isFile() && info.mtimeMs < modifiedBeforeMs) await removeFileIfPresent(path);
    } catch (error) {
      if (errorCode(error) !== CLEANUP_MISSING_CODE) throw error;
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
