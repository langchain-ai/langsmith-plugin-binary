export declare function ensurePrivateDirectory(root: string, segments: string[]): Promise<string>;
export declare function publishExclusive(path: string, contents: string, beforeCommit?: () => void): Promise<boolean>;
export declare function replacePrivateFile(root: string, path: string, contents: string): Promise<void>;
export declare function readPrivateFile(root: string, path: string): Promise<string | undefined>;
//# sourceMappingURL=atomic-file.d.ts.map