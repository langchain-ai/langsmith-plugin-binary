import { Client } from "langsmith";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "./constants.js";
export function createUploadClient(options) {
    const { apiKey, apiUrl, workspaceId, anonymizer, redactedFields } = options;
    return new Client({
        apiKey,
        apiUrl,
        workspaceId: workspaceId ?? "",
        autoBatchTracing: false,
        manualFlushMode: true,
        timeout_ms: UPLOAD_REQUEST_TIMEOUT_MS,
        disablePromptCache: true,
        debug: false,
        omitTracedRuntimeInfo: true,
        tracingMode: "langsmith",
        ...(anonymizer === undefined ? {} : { anonymizer, hideMetadata: anonymizer }),
        ...(redactedFields?.includes("inputs") ? { hideInputs: false } : {}),
        ...(redactedFields?.includes("outputs") ? { hideOutputs: false } : {}),
    });
}
//# sourceMappingURL=client.js.map