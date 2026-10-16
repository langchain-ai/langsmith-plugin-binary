export declare class FileLockTimeoutError extends Error {
    readonly blockedPath: string;
    constructor(blockedPath: string);
}
export declare class StorageNotWritableError extends Error {
    readonly folder: string;
    readonly code: string | undefined;
    constructor(folder: string, cause: unknown);
}
//# sourceMappingURL=errors.d.ts.map