import type { BinaryTarget, InstallableRelease, ReleaseQuery, StagingOptions } from "./models.js";
export declare function installDirectory(target: BinaryTarget, home?: string): string;
export declare function installedBinaryPath(target: BinaryTarget, installDir: string): string;
export declare function runningAsInstalledBinary(executablePath: string, installedPath: string): Promise<boolean>;
export declare function installRelease(release: InstallableRelease, installDir: string, query: ReleaseQuery, options?: StagingOptions): Promise<string>;
export declare function installRunningBinary(target: BinaryTarget, executablePath: string, installDir: string, version: string, options?: StagingOptions): Promise<string>;
//# sourceMappingURL=install-binary.d.ts.map