import { resolveUploadDestinationIdentities } from "./destination-identity.js";
import type { LangSmithUploadWriterOptions } from "./models.js";

export function resolveUploadDestinationFingerprint(options: LangSmithUploadWriterOptions): string {
  return resolveUploadDestinationIdentities(options).accountFingerprint;
}
