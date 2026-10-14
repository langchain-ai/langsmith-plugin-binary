import { createUploadClient } from "./client.js";
import { resolveUploadDestinationIdentities } from "./destination-identity.js";
import { createUploadAnonymizer } from "./redaction.js";
export function resolveUploadDestinations(options) {
    const resolved = resolveUploadDestinationIdentities(options);
    const destinations = resolved.destinations.map((destination) => {
        const anonymizer = createUploadAnonymizer(options.redact, options.redactExtraRules);
        const client = createUploadClient({
            apiKey: destination.apiKey,
            apiUrl: destination.apiUrl,
            ...(destination.workspaceId === undefined ? {} : { workspaceId: destination.workspaceId }),
            ...(anonymizer === undefined ? {} : { anonymizer }),
        });
        return {
            ...destination,
            ...(anonymizer === undefined ? {} : { anonymizer }),
            client,
        };
    });
    return { accountFingerprint: resolved.accountFingerprint, destinations };
}
//# sourceMappingURL=destinations.js.map