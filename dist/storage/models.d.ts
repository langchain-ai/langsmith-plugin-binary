export interface FileLockClaim {
    version: 1;
    id: string;
    pid: number;
    choosing: boolean;
    ticket: number;
}
export interface FileLockScanResult {
    claims: FileLockClaim[];
    blocked: boolean;
}
export interface BegunFileLock {
    claimDirectory: string;
    claim: FileLockClaim;
}
export interface LegacyDirectoryFileLockGate {
    path: string;
    dev: number;
    ino: number;
    birthtimeMs: number;
}
export interface FileLockHandle {
    release(): Promise<void>;
}
export interface FileLockOptions {
    timeoutMs?: number;
}
export type FileLockCallback<T> = () => T | Promise<T>;
//# sourceMappingURL=models.d.ts.map