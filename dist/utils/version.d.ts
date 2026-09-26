import type { ParsedVersion } from "../models.js";
export declare function parseVersion(version: string): ParsedVersion | undefined;
export declare function isVersion(version: string): boolean;
export declare function stampsVersion(contents: string, version: string): boolean;
export declare function isVersionNewer(candidate: string, current: string): boolean;
//# sourceMappingURL=version.d.ts.map