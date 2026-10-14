import { Client } from "langsmith";
import { UPLOAD_REQUEST_TIMEOUT_MS, UPLOAD_SDK_MAX_RETRIES } from "./constants.js";
import type { UploadClientOptions } from "./models.js";

export function createUploadClient(options: UploadClientOptions): Client {
  const { apiKey, apiUrl, workspaceId, anonymizer, redactedFields } = options;
  return new Client({
    apiKey,
    apiUrl,
    workspaceId: workspaceId ?? "",
    autoBatchTracing: false,
    manualFlushMode: true,
    timeout_ms: UPLOAD_REQUEST_TIMEOUT_MS,
    callerOptions: { maxRetries: UPLOAD_SDK_MAX_RETRIES },
    disablePromptCache: true,
    debug: false,
    omitTracedRuntimeInfo: true,
    tracingMode: "langsmith",
    ...(anonymizer === undefined ? {} : { anonymizer, hideMetadata: anonymizer }),
    ...(redactedFields?.includes("inputs") ? { hideInputs: false } : {}),
    ...(redactedFields?.includes("outputs") ? { hideOutputs: false } : {}),
  });
}
