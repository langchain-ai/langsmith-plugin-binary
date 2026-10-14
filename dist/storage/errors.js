import { resolve } from "node:path";
import { FILE_LOCK_TIMEOUT_ERROR_NAME, FILE_LOCK_TIMEOUT_MESSAGE } from "./constants.js";
export class FileLockTimeoutError extends Error {
    blockedPath;
    constructor(blockedPath) {
        super(`${FILE_LOCK_TIMEOUT_MESSAGE}: ${resolve(blockedPath)}`);
        this.name = FILE_LOCK_TIMEOUT_ERROR_NAME;
        this.blockedPath = resolve(blockedPath);
    }
}
//# sourceMappingURL=errors.js.map