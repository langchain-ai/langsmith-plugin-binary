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
            let client = destination.client;
            if (redactedFields.length > 0) {
                const key = JSON.stringify([destination.id, redactedFields]);
                const previous = clientsByMode.get(key);
                client = previous ?? createUploadClient({ ...destination, redactedFields });
                if (previous === undefined)
                    clientsByMode.set(key, client);
            }
            return client;
        },
    };
}
//# sourceMappingURL=client-cache.js.map