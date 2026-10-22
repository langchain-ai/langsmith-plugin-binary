import { Client } from "langsmith";
import { LOGIN_EXPIRED_STATUS } from "../../auth/renewal-constants.js";
import {
  UPLOAD_AUTHORIZATION_HEADER,
  UPLOAD_BEARER_PATTERN,
  UPLOAD_REQUEST_TIMEOUT_MS,
  UPLOAD_SDK_MAX_RETRIES,
} from "./constants.js";
import type { UploadClientOptions } from "./models.js";

const rejectedAuthorizations = new WeakMap<Client, string>();

export function createUploadClient(options: UploadClientOptions): Client {
  const { apiKey, apiUrl, workspaceId, login, anonymizer, redactedFields } = options;
  const auth = login === undefined ? { apiKey: apiKey ?? "", workspaceId: workspaceId ?? "" } : {};
  const client: Client = new Client({
    ...auth,
    apiUrl,
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
    fetchImplementation: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await fetch(input, init);
      if (response.status === LOGIN_EXPIRED_STATUS)
        rejectedAuthorizations.set(
          client,
          new Headers(init?.headers).get(UPLOAD_AUTHORIZATION_HEADER) ?? "",
        );
      return response;
    },
  });
  return client;
}

export function takeRejectedAccessToken(client: Client): string | undefined {
  const authorization = rejectedAuthorizations.get(client);
  rejectedAuthorizations.delete(client);
  return authorization?.replace(UPLOAD_BEARER_PATTERN, "") || undefined;
}
