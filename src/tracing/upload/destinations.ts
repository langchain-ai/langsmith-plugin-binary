import { createUploadClient } from "./client.js";
import { UPLOAD_KEY_UNUSABLE_MESSAGE, UPLOAD_SDK_API_KEY_FIELD } from "./constants.js";
import { resolveUploadDestinationIdentities } from "./destination-identity.js";
import type {
  LangSmithUploadWriterOptions,
  ResolvedUploadDestination,
  ResolvedUploadDestinations,
} from "./models.js";
import { createUploadAnonymizer } from "./redaction.js";

export function resolveUploadDestinations(
  options: LangSmithUploadWriterOptions,
): ResolvedUploadDestinations {
  const resolved = resolveUploadDestinationIdentities(options);
  const destinations: ResolvedUploadDestination[] = resolved.destinations.map((destination) => {
    const anonymizer = createUploadAnonymizer(options.redact, options.redactExtraRules);
    const client = createUploadClient({
      apiKey: destination.apiKey,
      apiUrl: destination.apiUrl,
      ...(destination.workspaceId === undefined ? {} : { workspaceId: destination.workspaceId }),
      ...(anonymizer === undefined ? {} : { anonymizer }),
    });
    if (Reflect.get(client, UPLOAD_SDK_API_KEY_FIELD) === undefined)
      throw new TypeError(UPLOAD_KEY_UNUSABLE_MESSAGE);
    return {
      ...destination,
      ...(anonymizer === undefined ? {} : { anonymizer }),
      client,
    };
  });
  return { accountFingerprint: resolved.accountFingerprint, destinations };
}
