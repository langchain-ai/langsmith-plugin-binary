import { lstat, readFile, readdir, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DIRECTORY_NOT_EMPTY_CODE, FILE_MISSING_CODE } from "../utils/constants.js";
import { describe, errorCode } from "../utils/errors.js";
import { removeFileIfPresent } from "../utils/files/cleanup.js";
import { ifMissing } from "../utils/files/missing.js";
import { FILE_LOCK_DIRECTORY_SUFFIX, STORAGE_CLAIM_FILE, STORAGE_ENGINE_FILE_PATTERNS, STORAGE_STALE_DIRECTORY_WARNING, STORAGE_STALE_REMOVAL_WARNING, } from "./constants.js";
import { processIsAlive } from "./file-lock-support.js";
export async function removeStaleStorageFiles(root, folders, modifiedBeforeMs) {
    let removed = 0;
    for (const folder of folders)
        removed += await removeStaleChildren(join(root, folder), modifiedBeforeMs);
    return removed;
}
async function removeStaleChildren(directory, modifiedBeforeMs) {
    let removed = 0;
    for (const name of await readdir(directory).catch(ifMissing([]))) {
        const path = join(directory, name);
        const info = await lstat(path).catch(ifMissing(undefined));
        if (info === undefined)
            continue;
        if (info.isDirectory()) {
            removed += await removeStaleChildren(path, modifiedBeforeMs);
            if (info.mtimeMs < modifiedBeforeMs)
                await rmdir(path).catch(warnUnlessExpected);
        }
        else if (info.mtimeMs < modifiedBeforeMs &&
            isEngineFile(path) &&
            !(await heldByLiveProcess(path))) {
            if (!(await removeFileIfPresent(path)))
                continue;
            console.warn(STORAGE_STALE_REMOVAL_WARNING, name);
            removed += 1;
        }
    }
    return removed;
}
function isEngineFile(path) {
    const name = basename(path);
    return (STORAGE_ENGINE_FILE_PATTERNS.some((pattern) => pattern.test(name)) ||
        (STORAGE_CLAIM_FILE.test(name) && basename(dirname(path)).endsWith(FILE_LOCK_DIRECTORY_SUFFIX)));
}
async function heldByLiveProcess(path) {
    if (!STORAGE_CLAIM_FILE.test(basename(path)))
        return false;
    try {
        const claim = JSON.parse(await readFile(path, "utf8"));
        return (typeof claim === "object" &&
            claim !== null &&
            "pid" in claim &&
            typeof claim.pid === "number" &&
            processIsAlive(claim.pid) === true);
    }
    catch {
        return false;
    }
}
function warnUnlessExpected(error) {
    const code = errorCode(error);
    if (code !== FILE_MISSING_CODE && code !== DIRECTORY_NOT_EMPTY_CODE)
        console.warn(STORAGE_STALE_DIRECTORY_WARNING, describe(error));
}
//# sourceMappingURL=stale-files.js.map