import { createUploadClient } from "./client.js";
import { normalizedRedactedFields } from "./redaction.js";
export function createUploadClientCache() {
    const clientsByMode = new Map();
    return {
        forSubmission(destination, submission) {
            const redactedFields = normalizedRedactedFields(submission.redactedFields).filter((field) => submission.privacyMode === "full" &&
                !(submission.operation === "patch" &&
                    field === "outputs" &&
                    Object.hasOwn(destination.updates ?? {}, "outputs")));
            const includeRuntimeMetadata = destination.includeRuntimeMetadata === true && submission.privacyMode === "full";
            let client = destination.client;
            if (redactedFields.length > 0 || includeRuntimeMetadata) {
                const key = JSON.stringify([destination.id, includeRuntimeMetadata, redactedFields]);
                const previous = clientsByMode.get(key);
                client =
                    previous ??
                        createUploadClient({ ...destination, redactedFields, includeRuntimeMetadata });
                if (previous === undefined)
                    clientsByMode.set(key, client);
            }
            return client;
        },
    };
}
//# sourceMappingURL=client-cache.js.map