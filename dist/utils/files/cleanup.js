import { rmdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, errorCode } from "../errors.js";
import { FILE_MISSING_CODE } from "../constants.js";
import { CLEANUP_IGNORED_DIRECTORY_CODES } from "./cleanup-constants.js";
export async function removeFileIfPresent(path) {
    try {
        await unlink(path);
        return true;
    }
    catch (error) {
        if (errorCode(error) === FILE_MISSING_CODE)
            return false;
        throw error;
    }
}
export async function removeDirectoryBestEffort(path, warning) {
    try {
        await rmdir(path);
    }
    catch (error) {
        if (errorCode(error) !== FILE_MISSING_CODE)
            console.warn(warning, describe(error));
    }
}
export async function removeEmptyAncestors(directory, root) {
    for (let current = directory; current !== root && current !== dirname(current);) {
        try {
            await rmdir(current);
        }
        catch (error) {
            const code = errorCode(error);
            if (CLEANUP_IGNORED_DIRECTORY_CODES.some((ignored) => ignored === code))
                return;
            throw error;
        }
        current = dirname(current);
    }
}
//# sourceMappingURL=cleanup.js.map