export declare class UploadError extends Error {
    readonly retryable: boolean;
    readonly status: number | undefined;
    constructor(cause: unknown);
}
export declare function isAlreadyReceived(cause: unknown): boolean;
//# sourceMappingURL=errors.d.ts.map