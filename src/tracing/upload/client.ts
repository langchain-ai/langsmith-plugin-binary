import { Client, type ClientConfig } from "langsmith";
import { LOGIN_API_KEY_VARIABLES } from "../../auth/constants.js";
import { LOGIN_EXPIRED_STATUS, LOGIN_NO_ACCESS_STATUS } from "../../auth/expiry-constants.js";
import { withLoginProfile } from "../../auth/profile.js";
import { withoutEnvVariables } from "../../utils/env.js";
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
  const auth =
    login === undefined
      ? { apiKey: apiKey ?? "", workspaceId: workspaceId ?? "" }
      : login.workspaceId === undefined
        ? {}
        : { workspaceId: login.workspaceId };
  const config: ClientConfig = {
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
      if (response.status === LOGIN_EXPIRED_STATUS || response.status === LOGIN_NO_ACCESS_STATUS)
        rejectedAuthorizations.set(
          client,
          new Headers(init?.headers).get(UPLOAD_AUTHORIZATION_HEADER) ?? "",
        );
      return response;
    },
  };
  const client = withoutEnvVariables(LOGIN_API_KEY_VARIABLES, () =>
    login === undefined ? new Client(config) : withLoginProfile(login, () => new Client(config)),
  );
  return client;
}

export function takeRejectedAccessToken(client: Client): string | undefined {
  const authorization = rejectedAuthorizations.get(client);
  rejectedAuthorizations.delete(client);
  return authorization?.replace(UPLOAD_BEARER_PATTERN, "") || undefined;
}
