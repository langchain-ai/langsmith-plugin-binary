import type { NormalizedRunPatchField } from "./models.js";
export declare const UPLOAD_ACCOUNT_FINGERPRINT_PREFIX = "account_";
export declare const UPLOAD_DESTINATION_ID_PREFIX = "destination_";
export declare const UPLOAD_FINGERPRINT_LENGTH = 32;
export declare const UPLOAD_CONTROL_CHARACTER_PATTERN: RegExp;
export declare const UPLOAD_API_URL_TRAILING_SLASH_PATTERN: RegExp;
export declare const UPLOAD_UUID_PATTERN: RegExp;
export declare const UPLOAD_REPLICA_UUID_V7_PATTERN: RegExp;
export declare const UPLOAD_REPLICA_UUID_V5_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export declare const UPLOAD_REPLICA_UUID_V5_NAMESPACE_BYTES: Buffer<ArrayBuffer>;
export declare const UPLOAD_REPLICA_UUID_V5_DOMAIN = "langchain-upload-replica-v1";
export declare const UPLOAD_REPLICA_DOTTED_ORDER_ID_LENGTH = 36;
export declare const UPLOAD_REPLICA_IDENTITY_UPDATE_FIELDS: ReadonlySet<string>;
export declare const UPLOAD_REPLICA_PATCH_UPDATE_FIELDS: ReadonlySet<string>;
export declare const UPLOAD_PATCH_FIELDS: ReadonlySet<NormalizedRunPatchField>;
export declare const UPLOAD_REDACTED_FIELDS: readonly ["inputs", "outputs"];
//# sourceMappingURL=constants.d.ts.map