import type { SdkOmittedRunFields, UploadAnonymizer, UploadRedactRule } from "./models.js";
export declare function createUploadAnonymizer(enabled: boolean, extraRules?: readonly UploadRedactRule[]): UploadAnonymizer | undefined;
export declare function redactSdkOmittedFields(payload: SdkOmittedRunFields, anonymizer?: UploadAnonymizer): void;
//# sourceMappingURL=redaction.d.ts.map