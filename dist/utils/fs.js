import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export async function writeFully(handle, chunk) {
    let offset = 0;
    while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset);
        if (bytesWritten === 0)
            throw new Error("could not write the release asset");
        offset += bytesWritten;
    }
}
export function readVersion(repositoryRoot, versionFile) {
    const parsed = JSON.parse(readFileSync(resolve(repositoryRoot, versionFile), "utf-8"));
    if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
        throw new Error(`${versionFile} declares no version`);
    }
    return parsed.version;
}
//# sourceMappingURL=fs.js.map