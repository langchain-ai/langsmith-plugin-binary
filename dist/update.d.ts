import type { BinaryTarget, HostOptions, InstalledBinary, InstallOptions, UpdateOptions, UpdateResult } from "./models.js";
export declare function updateFromGitHub(target: BinaryTarget, options: UpdateOptions): Promise<UpdateResult>;
export declare function installFromReleases(target: BinaryTarget, options?: InstallOptions): Promise<InstalledBinary>;
export declare function installLocalCopy(target: BinaryTarget, executablePath: string, version: string, options?: HostOptions): Promise<InstalledBinary>;
//# sourceMappingURL=update.d.ts.map