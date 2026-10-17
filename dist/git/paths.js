import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GIT_DIRECTORY_NAME, GIT_FILE_POINTER, GIT_MARKERS } from "./constants.js";
function gitMarkerAt(directory) {
    const marker = join(directory, GIT_DIRECTORY_NAME);
    try {
        if (statSync(marker).isDirectory())
            return GIT_MARKERS.REPOSITORY_ROOT;
    }
    catch {
        return GIT_MARKERS.NOTHING_HERE;
    }
    return pointsAtGitDirectory(directory, marker)
        ? GIT_MARKERS.REPOSITORY_ROOT
        : GIT_MARKERS.ONLY_GIT_CAN_SAY;
}
function pointsAtGitDirectory(directory, marker) {
    try {
        const pointer = readFileSync(marker, "utf-8").match(GIT_FILE_POINTER)?.[1];
        return pointer !== undefined && statSync(resolve(directory, pointer)).isDirectory();
    }
    catch {
        return false;
    }
}
export function rootFromGitMarker(directory) {
    let current = resolve(directory);
    for (;;) {
        const marker = gitMarkerAt(current);
        if (marker === GIT_MARKERS.REPOSITORY_ROOT)
            return current;
        if (marker === GIT_MARKERS.ONLY_GIT_CAN_SAY)
            return undefined;
        const parent = dirname(current);
        const reachedFilesystemRoot = parent === current;
        if (reachedFilesystemRoot)
            return null;
        current = parent;
    }
}
//# sourceMappingURL=paths.js.map