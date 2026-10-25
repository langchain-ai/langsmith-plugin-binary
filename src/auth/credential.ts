import { fillTemplate } from "../utils/format.js";
import {
  LOGIN_API_KEY_VARIABLES,
  LOGIN_DEFAULT_API_URL,
  LOGIN_ENDPOINT_MISMATCH_REASON,
  LOGIN_NONE_REASON,
  LOGIN_REPLICA_REFUSED_REASON,
} from "./constants.js";
import { sdkSetting } from "../utils/sdk/normalize.js";
import type {
  LoginReplica,
  UploadCredential,
  UploadCredentialOptions,
  UploadWorkspace,
} from "./models.js";
import { readLoginProfile, sameServer } from "./profile.js";

export function resolveUploadCredential(options: UploadCredentialOptions = {}): UploadCredential {
  const env = options.env ?? process.env;
  const workspaceId = sdkSetting(options.workspaceId);
  const workspace = workspaceId ? { workspaceId } : {};
  const configuredUrl = sdkSetting(options.apiUrl);
  const apiUrl = options.apiUrlIsDefault ? undefined : configuredUrl;
  const apiKey = sdkSetting(options.apiKey);
  if (apiKey !== undefined) return keyCredential(apiKey, configuredUrl, workspace);
  const login = loginCredential(env, apiUrl, workspace);
  if (login.kind === "login") return login;
  const envKey = LOGIN_API_KEY_VARIABLES.map((name) => sdkSetting(env[name])).find(Boolean);
  return envKey === undefined ? login : keyCredential(envKey, configuredUrl, workspace);
}

function keyCredential(
  apiKey: string,
  apiUrl: string | undefined,
  workspace: UploadWorkspace,
): UploadCredential {
  return { kind: "api-key", apiKey, apiUrl: apiUrl ?? LOGIN_DEFAULT_API_URL, ...workspace };
}

function loginCredential(
  env: NodeJS.ProcessEnv,
  apiUrl: string | undefined,
  workspace: UploadWorkspace,
): UploadCredential {
  const profile = readLoginProfile(env);
  if (profile === undefined) return { kind: "none", reason: LOGIN_NONE_REASON };
  if (apiUrl !== undefined && !sameServer(apiUrl, profile.apiUrl))
    return {
      kind: "none",
      reason: fillTemplate(LOGIN_ENDPOINT_MISMATCH_REASON, { loginUrl: profile.apiUrl, apiUrl }),
    };
  const { configPath, profile: name, workspaceId: loginWorkspace } = profile;
  return {
    kind: "login",
    login: {
      configPath,
      profile: name,
      ...(loginWorkspace === undefined ? {} : { workspaceId: loginWorkspace }),
    },
    apiUrl: apiUrl ?? profile.apiUrl,
    ...workspace,
  };
}

export function refusedLoginReplicas(
  replicas: readonly LoginReplica[] | undefined,
  apiUrl: string,
): string | undefined {
  const refused = (replicas ?? [])
    .filter((replica) => sdkSetting(replica.apiKey) === undefined && replica.apiUrl !== undefined)
    .map(({ apiUrl: url }) => url!)
    .filter((url) => !sameServer(url, apiUrl));
  return refused.length === 0
    ? undefined
    : fillTemplate(LOGIN_REPLICA_REFUSED_REASON, { urls: refused.join(", "), apiUrl });
}

export function loginReplicaRefusal(
  replicas: readonly LoginReplica[] | undefined,
  apiUrl: string,
): string | undefined {
  const configured = replicas ?? [];
  const usable = configured.some(
    (replica) =>
      sdkSetting(replica.apiKey) !== undefined ||
      replica.apiUrl === undefined ||
      sameServer(replica.apiUrl, apiUrl),
  );
  return usable ? undefined : refusedLoginReplicas(configured, apiUrl);
}
