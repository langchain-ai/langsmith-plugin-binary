export const UPLOAD_ACCOUNT_FINGERPRINT_PREFIX = "account_";
export const UPLOAD_DESTINATION_ID_PREFIX = "destination_";
export const UPLOAD_FINGERPRINT_LENGTH = 32;
export const UPLOAD_CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
export const UPLOAD_API_URL_TRAILING_SLASH_PATTERN = /\/$/;
export const UPLOAD_PATCH_FIELDS = new Set([
    "inputs",
    "outputs",
    "end_time",
    "error",
    "tags",
    "serialized",
    "events",
    "reference_example_id",
]);
//# sourceMappingURL=constants.js.map