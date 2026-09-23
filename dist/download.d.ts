import type { InstallableRelease, ReleaseQuery, SignatureVerifier } from "./models.js";
export declare function downloadAsset(release: InstallableRelease, destination: string, query: ReleaseQuery): Promise<void>;
export declare const verifyAdHocSignature: SignatureVerifier;
//# sourceMappingURL=download.d.ts.map