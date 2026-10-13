export declare function removeFileIfPresent(path: string): Promise<boolean>;
export declare function removeEmptyDirectories(paths: readonly string[]): Promise<void>;
export declare function removeStaleFiles(directory: string, pattern: RegExp, modifiedBeforeMs: number): Promise<void>;
//# sourceMappingURL=cleanup.d.ts.map