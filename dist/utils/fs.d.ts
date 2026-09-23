import type * as fs from "node:fs/promises";
export declare function writeFully(handle: fs.FileHandle, chunk: Buffer): Promise<void>;
export declare function readVersion(repositoryRoot: string, versionFile: string): string;
//# sourceMappingURL=fs.d.ts.map