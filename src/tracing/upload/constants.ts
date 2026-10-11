import type { NormalizedRunPatchField } from "./models.js";

export const UPLOAD_ACCOUNT_FINGERPRINT_PREFIX = "account_";
export const UPLOAD_DESTINATION_ID_PREFIX = "destination_";
export const UPLOAD_FINGERPRINT_LENGTH = 32;
export const UPLOAD_CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
export const UPLOAD_API_URL_TRAILING_SLASH_PATTERN = /\/$/;
export const UPLOAD_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UPLOAD_REPLICA_UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UPLOAD_REPLICA_UUID_V5_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export const UPLOAD_REPLICA_UUID_V5_NAMESPACE_BYTES = Buffer.from(
  UPLOAD_REPLICA_UUID_V5_NAMESPACE.replaceAll("-", ""),
  "hex",
);
export const UPLOAD_REPLICA_UUID_V5_DOMAIN = "langchain-upload-replica-v1";
export const UPLOAD_REPLICA_DOTTED_ORDER_ID_LENGTH = 36;
export const UPLOAD_REPLICA_IDENTITY_UPDATE_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "run_type",
  "start_time",
  "parent_run_id",
  "session_id",
  "session_name",
  "trace_id",
  "dotted_order",
]);
export const UPLOAD_REPLICA_PATCH_UPDATE_FIELDS: ReadonlySet<string> = new Set([
  "inputs",
  "outputs",
  "end_time",
  "extra",
  "tags",
  "error",
  "serialized",
  "reference_example_id",
  "events",
]);
export const UPLOAD_PATCH_FIELDS: ReadonlySet<NormalizedRunPatchField> = new Set([
  "inputs",
  "outputs",
  "end_time",
  "error",
  "tags",
  "serialized",
  "events",
  "reference_example_id",
] as const);

export const UPLOAD_REDACTED_FIELDS = ["inputs", "outputs"] as const;
