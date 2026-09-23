import type { BinaryTarget, InstallableRelease, ReleaseQuery } from "./models.js";
export declare function parseReleases(value: unknown, target: BinaryTarget, platform: string, arch: string, allowPrerelease?: boolean): InstallableRelease[];
export declare function newestRelease(releases: InstallableRelease[], currentVersion: string): InstallableRelease | undefined;
export declare function fetchReleases(query: ReleaseQuery): Promise<InstallableRelease[]>;
export declare function fetchTaggedRelease(query: ReleaseQuery, tag: string): Promise<InstallableRelease | undefined>;
//# sourceMappingURL=releases.d.ts.map