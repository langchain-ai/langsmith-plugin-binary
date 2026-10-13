import type { RedactedRunField, SdkOmittedRunFields, UploadAnonymizer, UploadRedactRule } from "./models.js";
export declare function createUploadAnonymizer(enabled: boolean, extraRules?: readonly UploadRedactRule[]): UploadAnonymizer | undefined;
export declare function redactSdkOmittedFields(payload: SdkOmittedRunFields, anonymizer?: UploadAnonymizer): void;
export declare function normalizedRedactedFields(value: unknown): readonly RedactedRunField[];
//# sourceMappingURL=redaction.d.ts.map