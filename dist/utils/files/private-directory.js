import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
export async function listPrivateDirectory(root, directory) {
    const storageRoot = resolve(root);
    const target = resolve(directory);
    const relativePath = relative(storageRoot, target);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error("Private directory is outside storage root");
    }
    let current = storageRoot;
    for (const segment of ["", ...relativePath.split(sep).filter(Boolean)]) {
        if (segment)
            current = join(current, segment);
        const info = await lstatDirectory(current);
        if (!info)
            return undefined;
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Private path contains a non-directory");
    }
    const entries = await readdir(target, { withFileTypes: true });
    const finalInfo = await lstat(target);
    if (!finalInfo.isDirectory() || finalInfo.isSymbolicLink())
        throw new Error("Private path changed during enumeration");
    return entries;
}
async function lstatDirectory(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return undefined;
        throw error;
    }
}
function errorCode(error) {
    return error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : undefined;
}
//# sourceMappingURL=private-directory.js.map