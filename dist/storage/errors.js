import { resolve } from "node:path";
import { FILE_LOCK_TIMEOUT_ERROR_NAME, FILE_LOCK_TIMEOUT_MESSAGE, STORAGE_NOT_WRITABLE_ERROR_NAME, STORAGE_NOT_WRITABLE_FIX, STORAGE_NOT_WRITABLE_MESSAGE, } from "./constants.js";
import { errorCode } from "../utils/errors.js";
export class FileLockTimeoutError extends Error {
    blockedPath;
    constructor(blockedPath) {
        super(`${FILE_LOCK_TIMEOUT_MESSAGE}: ${resolve(blockedPath)}`);
        this.name = FILE_LOCK_TIMEOUT_ERROR_NAME;
        this.blockedPath = resolve(blockedPath);
    }
}
export class StorageNotWritableError extends Error {
    folder;
    code;
    constructor(folder, cause) {
        super(`${STORAGE_NOT_WRITABLE_MESSAGE} ${resolve(folder)}. ${STORAGE_NOT_WRITABLE_FIX}`, {
            cause,
        });
        this.name = STORAGE_NOT_WRITABLE_ERROR_NAME;
        this.folder = resolve(folder);
        this.code = errorCode(cause);
    }
}
//# sourceMappingURL=errors.js.map