import type { VersionCheckFailure } from "../models.js";
export declare function worthRetrying(failure: VersionCheckFailure): boolean;
export declare function worthKeeping(failure: VersionCheckFailure): boolean;
export declare function whyTheVersionIsWrong(reported: string, expected: string): string;
export declare function whyTheSignatureStoppedMatching(error: unknown, staged: string | undefined): string;
export declare function whyTheVersionCheckFailed(failure: VersionCheckFailure, staged: string | undefined): string;
//# sourceMappingURL=staging.d.ts.map