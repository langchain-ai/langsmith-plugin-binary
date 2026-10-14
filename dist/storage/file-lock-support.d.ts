import type { FileLockOptions } from "./models.js";
export declare function processIsAlive(pid: number): boolean | undefined;
export declare function removeFile(filePath: string): Promise<boolean>;
export declare function isBusyFileError(error: unknown): boolean;
export declare function timeoutMs(options: FileLockOptions | undefined): number;
export declare function waitForNextScan(deadline: number, blockedPath: string): Promise<void>;
//# sourceMappingURL=file-lock-support.d.ts.map