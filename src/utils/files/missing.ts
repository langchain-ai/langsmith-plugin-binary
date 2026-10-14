import { FILE_MISSING_CODE } from "../constants.js";
import { errorCode } from "../errors.js";

export function ifMissing<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if (errorCode(error) === FILE_MISSING_CODE) return fallback;
    throw error;
  };
}
