import { resolve } from "node:path";
import { FILE_LOCK_TIMEOUT_ERROR_NAME, FILE_LOCK_TIMEOUT_MESSAGE } from "./constants.js";

export class FileLockTimeoutError extends Error {
  constructor(filePath: string) {
    super(`${FILE_LOCK_TIMEOUT_MESSAGE}: ${resolve(filePath)}`);
    this.name = FILE_LOCK_TIMEOUT_ERROR_NAME;
  }
}
