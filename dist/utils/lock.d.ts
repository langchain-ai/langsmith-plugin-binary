import * as fs from "node:fs/promises";
export declare function acquireLock(lockFile: string, now: number): Promise<fs.FileHandle | undefined>;
export declare function releaseLock(lockFile: string, lock: fs.FileHandle): Promise<void>;
//# sourceMappingURL=lock.d.ts.map