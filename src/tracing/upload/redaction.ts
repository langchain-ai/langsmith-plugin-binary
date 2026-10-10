import { createSecretAnonymizer } from "langsmith/anonymizer";
import type { SdkOmittedRunFields, UploadAnonymizer, UploadRedactRule } from "./models.js";

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
