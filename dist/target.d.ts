import type { BinaryTarget, BinaryTargetOptions } from "./models.js";
export declare function resolveTarget(options: BinaryTargetOptions): BinaryTarget;
export declare function isPublishedTarget(target: BinaryTarget, platform: string, arch: string): boolean;
export declare function releaseAssetName(target: BinaryTarget, platform: string, arch: string, version: string): string;
//# sourceMappingURL=target.d.ts.map