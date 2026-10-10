import type { FileLockCallback, FileLockHandle, FileLockOptions } from "./models.js";
export declare function tryAcquireFileLock(filePath: string): Promise<FileLockHandle | undefined>;
export declare function waitForFileLockClaim(filePath: string, pid: number, options?: FileLockOptions): Promise<boolean>;
export declare function withFileLock<T>(filePath: string, callback: FileLockCallback<T>, options?: FileLockOptions): Promise<T>;
//# sourceMappingURL=file-lock.d.ts.map