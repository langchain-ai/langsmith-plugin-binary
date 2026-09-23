import type { BinaryTarget, BinaryTargetOptions } from "./models.js";
export declare function resolveTarget(options: BinaryTargetOptions): BinaryTarget;
export declare function isPublishedTarget(target: BinaryTarget, platform: string, arch: string): boolean;
export declare function releaseAssetName(target: BinaryTarget, platform: string, arch: string, version: string): string;
export declare function defaultReleasesApi(target: BinaryTarget): string;
export declare function releaseDownloadPrefix(target: BinaryTarget): string;
export declare function githubRequestHeaders(target: BinaryTarget, currentVersion: string): Record<string, string>;
export declare function configuredReleasesApi(target: BinaryTarget, environment?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=target.d.ts.map