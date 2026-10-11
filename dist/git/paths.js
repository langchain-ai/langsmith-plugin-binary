import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GIT_DIRECTORY_NAME, GIT_MARKERS } from "./constants.js";
function gitMarkerAt(directory) {
    try {
        return statSync(join(directory, GIT_DIRECTORY_NAME)).isDirectory()
            ? GIT_MARKERS.REPOSITORY_ROOT
            : GIT_MARKERS.ONLY_GIT_CAN_SAY;
    }
    catch {
        return GIT_MARKERS.NOTHING_HERE;
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