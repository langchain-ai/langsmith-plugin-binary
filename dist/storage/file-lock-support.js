import { unlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { FILE_LOCK_BUSY_FILE_CODES, FILE_LOCK_DEFAULT_TIMEOUT_MS, FILE_LOCK_INVALID_TIMEOUT_MESSAGE, FILE_LOCK_POLL_INTERVAL_MS, } from "./constants.js";
import { errorCode } from "../utils/errors.js";
import { FILE_MISSING_CODE, PROCESS_CHECK_SIGNAL, PROCESS_MISSING_CODE, } from "../utils/constants.js";
import { FileLockTimeoutError } from "./errors.js";
export function processIsAlive(pid) {
    try {
        process.kill(pid, PROCESS_CHECK_SIGNAL);
        return true;
    }
    catch (error) {
        if (errorCode(error) === PROCESS_MISSING_CODE)
            return false;
        return undefined;
    }
}
export async function removeFile(filePath) {
    try {
        await unlink(filePath);
        return true;
    }
    catch (error) {
        if (errorCode(error) === FILE_MISSING_CODE)
            return true;
        return false;
    }
}
export function isBusyFileError(error) {
    return FILE_LOCK_BUSY_FILE_CODES.includes(errorCode(error) ?? "");
}
export function timeoutMs(options) {
    const value = options?.timeoutMs ?? FILE_LOCK_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(value) || value <= 0)
        throw new RangeError(FILE_LOCK_INVALID_TIMEOUT_MESSAGE);
    return value;
}
export function waitForNextScan(deadline, blockedPath) {
    const remaining = deadline - performance.now();
    if (remaining <= 0)
        return Promise.reject(new FileLockTimeoutError(blockedPath));
    return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(FILE_LOCK_POLL_INTERVAL_MS, remaining)));
}
//# sourceMappingURL=file-lock-support.js.map