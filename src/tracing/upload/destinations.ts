import { createUploadClient } from "./client.js";
import type { Client } from "langsmith";
import type { UploadLogin } from "../../auth/models.js";
import { readProfileAt, sameServer } from "../../auth/profile.js";
import {
  UPLOAD_KEY_UNUSABLE_MESSAGE,
  UPLOAD_LOGIN_UNUSABLE_MESSAGE,
  UPLOAD_SDK_API_KEY_FIELD,
  UPLOAD_SDK_API_URL_FIELD,
} from "./constants.js";
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
      ...destination,
      ...(anonymizer === undefined ? {} : { anonymizer }),
    });
    if (
      destination.login === undefined &&
      Reflect.get(client, UPLOAD_SDK_API_KEY_FIELD) === undefined
    )
      throw new TypeError(UPLOAD_KEY_UNUSABLE_MESSAGE);
    if (destination.login !== undefined && !usesLogin(destination.login, client))
      throw new TypeError(UPLOAD_LOGIN_UNUSABLE_MESSAGE);
    return {
      ...destination,
      ...(anonymizer === undefined ? {} : { anonymizer }),
      client,
    };
  });
  return { accountFingerprint: resolved.accountFingerprint, destinations };
}

function usesLogin(login: UploadLogin, client: Client): boolean {
  if (Reflect.get(client, UPLOAD_SDK_API_KEY_FIELD) !== undefined) return false;
  const loginUrl = readProfileAt(login.configPath, login.profile)?.apiUrl;
  const clientUrl = Reflect.get(client, UPLOAD_SDK_API_URL_FIELD);
  return (
    loginUrl === undefined || (typeof clientUrl === "string" && sameServer(clientUrl, loginUrl))
  );
}
