import { Client } from "langsmith";
import type { UploadClientOptions } from "./models.js";

export function createUploadClient(options: UploadClientOptions): Client {
  const { apiKey, apiUrl, workspaceId, anonymizer, redactedFields } = options;
  return new Client({
    apiKey,
    apiUrl,
    workspaceId: workspaceId ?? "",
    autoBatchTracing: false,
    disablePromptCache: true,
    debug: false,
    omitTracedRuntimeInfo: true,
    tracingMode: "langsmith",
    ...(anonymizer === undefined ? {} : { anonymizer, hideMetadata: anonymizer }),
    ...(redactedFields?.includes("inputs") ? { hideInputs: false } : {}),
    ...(redactedFields?.includes("outputs") ? { hideOutputs: false } : {}),
  });
}
