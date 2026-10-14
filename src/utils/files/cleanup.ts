import { rmdir } from "node:fs/promises";
import { FILE_MISSING_CODE } from "../constants.js";
import { describe, errorCode } from "../errors.js";

export async function removeDirectoryBestEffort(path: string, warning: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (errorCode(error) !== FILE_MISSING_CODE) console.warn(warning, describe(error));
  }
}
