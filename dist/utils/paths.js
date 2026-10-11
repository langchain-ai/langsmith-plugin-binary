import { statSync } from "node:fs";
import { dirname } from "node:path";
export function nearestExistingDirectory(path) {
    let current = path;
    for (;;) {
        const parent = dirname(current);
        const reachedFilesystemRoot = parent === current;
        if (reachedFilesystemRoot)
            return undefined;
        try {
            if (statSync(current).isDirectory())
                return current;
        }
        catch { }
        current = parent;
    }
}
//# sourceMappingURL=paths.js.map