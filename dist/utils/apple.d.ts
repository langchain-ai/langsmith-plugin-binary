import type { Environment } from "../models.js";
export declare function missingAppleCredentials(env: Environment): string[];
export declare function decodeBase64Credential(value: string, name: string): Buffer;
export declare function developerIdIdentity(findIdentityOutput: string): string;
export declare function developerIdRequirement(identity: string): string;
export declare function acceptedSubmissionId(submission: {
    id?: string;
    status?: string;
}): string;
export declare function userKeychains(): string[];
export declare function searchUserKeychains(keychains: string[]): void;
export declare function writeCredentialFile(path: string, value: string, name: string): Promise<string>;
//# sourceMappingURL=apple.d.ts.map