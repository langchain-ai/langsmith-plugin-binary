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
    transient?: boolean;
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
export interface ClaimAttempt {
    filePath: string;
    claimDirectory: string;
    claim: FileLockClaim;
    ownPath: string;
    waitForPeers: boolean;
    deadline: number;
    busyDeadline: number;
}
export type TryAcquireFileLock = (filePath: string) => Promise<FileLockHandle | undefined>;
export interface LegacyGateAttempt {
    gatePath: string;
    filePath: string;
    deadline: number;
    tryAcquire: TryAcquireFileLock;
    retriedMissingPermission: boolean;
}
//# sourceMappingURL=models.d.ts.map