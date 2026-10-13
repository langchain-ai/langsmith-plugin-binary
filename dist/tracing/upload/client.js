import { Client } from "langsmith";
export function createUploadClient(options) {
    const { apiKey, apiUrl, workspaceId, anonymizer, redactedFields } = options;
    return new Client({
        apiKey,
        apiUrl,
        workspaceId: workspaceId ?? "",
        autoBatchTracing: false,
        tracingSamplingRate: 1,
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