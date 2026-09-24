import type { VersionCheck, VersionCheckFailure } from "../models.js";
export declare function failureKind(error: unknown, elapsed: number): VersionCheckFailure;
export declare function reportedVersion(executable: string, timeout: number): Promise<VersionCheck>;
export declare function signAdHoc(binary: string): void;
export declare const security: (args: string[]) => string;
export declare const codesign: (args: string[]) => void;
export declare function securityWithoutEchoingCredentials(args: string[], failure: string): void;
//# sourceMappingURL=process.d.ts.map