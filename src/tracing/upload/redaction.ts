import { createSecretAnonymizer } from "langsmith/anonymizer";
import { UPLOAD_REDACTED_FIELDS } from "./constants.js";
import type {
  RedactedRunField,
  SdkOmittedRunFields,
  UploadAnonymizer,
  UploadRedactRule,
} from "./models.js";

export function createUploadAnonymizer(
  enabled: boolean,
  extraRules?: readonly UploadRedactRule[],
): UploadAnonymizer | undefined {
  if (!enabled) return undefined;
  const normalizedRules = extraRules?.map(({ pattern, replace }) => ({
    pattern,
    ...(replace === undefined ? {} : { replace }),
  }));
  return createSecretAnonymizer(
    normalizedRules === undefined ? {} : { extraRules: normalizedRules },
  );
}

export function redactSdkOmittedFields(
  payload: SdkOmittedRunFields,
  anonymizer?: UploadAnonymizer,
): void {
  if (!anonymizer) return;
  if (payload["tags"] !== undefined) payload["tags"] = anonymizer(payload["tags"]);
  if (payload["serialized"] !== undefined) {
    payload["serialized"] = anonymizer(payload["serialized"]);
  }
  if (payload["events"] !== undefined) payload["events"] = anonymizer(payload["events"]);
}

export function normalizedRedactedFields(value: unknown): readonly RedactedRunField[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((field) => !UPLOAD_REDACTED_FIELDS.includes(field)) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError("Redacted fields must be unique inputs or outputs");
  }
  return UPLOAD_REDACTED_FIELDS.filter((field) => value.includes(field));
}
