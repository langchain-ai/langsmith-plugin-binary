import { resolveUploadDestinationIdentities } from "./destination-identity.js";
import type { LangSmithUploadIdentityOptions } from "./models.js";

export function resolveUploadDestinationFingerprint(
  options: LangSmithUploadIdentityOptions,
): string {
  return resolveUploadDestinationIdentities(options).accountFingerprint;
}
