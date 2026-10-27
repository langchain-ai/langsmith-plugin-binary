import { fillTemplate } from "../utils/format.js";
import {
  AGENT_ID_INVALID_REASON,
  AGENT_ID_PATTERN,
  LOGIN_API_KEY_VARIABLES,
  LOGIN_DEFAULT_API_URL,
  LOGIN_ENDPOINT_MISMATCH_REASON,
  LOGIN_NONE_REASON,
  LOGIN_PROFILE_VARIABLE,
  LOGIN_REPLICA_REFUSED_REASON,
  LOGIN_WORKSPACE_ID_PATTERN,
  LOGIN_WORKSPACE_INVALID_REASON,
  LOGIN_WORKSPACE_VARIABLE,
} from "./constants.js";
import { sdkSetting } from "../utils/sdk/normalize.js";
import type {
  LoginReplica,
  UploadCredential,
  UploadCredentialOptions,
  UploadWorkspace,
} from "./models.js";
import { loginCommand, readLoginProfile, sameServer } from "./profile.js";

export function resolveUploadCredential(options: UploadCredentialOptions = {}): UploadCredential {
  const env = options.env ?? process.env;
  const workspaceId = sdkSetting(options.workspaceId);
  const workspace = workspaceId ? { workspaceId } : {};
  const configuredUrl = sdkSetting(options.apiUrl);
  const apiUrl = options.apiUrlIsDefault ? undefined : configuredUrl;
  const apiKey = sdkSetting(options.apiKey);
  const { agentId } = options;
  if (agentId !== undefined && !AGENT_ID_PATTERN.test(agentId))
    return {
      kind: "none",
      reason: fillTemplate(AGENT_ID_INVALID_REASON, { agentId: JSON.stringify(agentId) }),
    };
  if (apiKey !== undefined) return keyCredential(apiKey, configuredUrl);
  const login = loginCredential(env, apiUrl, workspace, options.profile);
  if (login.kind === "login" || options.profile) return login;
  const envKey = LOGIN_API_KEY_VARIABLES.map((name) => sdkSetting(env[name])).find(Boolean);
  return envKey === undefined ? login : keyCredential(envKey, configuredUrl);
}

function keyCredential(apiKey: string, apiUrl: string | undefined): UploadCredential {
  return { kind: "api-key", apiKey, apiUrl: apiUrl ?? LOGIN_DEFAULT_API_URL };
}

function loginCredential(
  env: NodeJS.ProcessEnv,
  apiUrl: string | undefined,
  workspace: UploadWorkspace,
  configuredProfile: string | undefined,
): UploadCredential {
  if (
    workspace.workspaceId !== undefined &&
    !LOGIN_WORKSPACE_ID_PATTERN.test(workspace.workspaceId)
  )
    return {
      kind: "none",
      reason: fillTemplate(LOGIN_WORKSPACE_INVALID_REASON, {
        workspaceId: JSON.stringify(workspace.workspaceId),
      }),
    };
  const profile = readLoginProfile(env, configuredProfile);
  if (profile === undefined)
    return {
      kind: "none",
      reason: fillTemplate(LOGIN_NONE_REASON, {
        command: loginCommand(configuredProfile || env[LOGIN_PROFILE_VARIABLE]),
      }),
    };
  if (apiUrl !== undefined && !sameServer(apiUrl, profile.apiUrl))
    return {
      kind: "none",
      reason: fillTemplate(LOGIN_ENDPOINT_MISMATCH_REASON, { loginUrl: profile.apiUrl, apiUrl }),
    };
  const { configPath, profile: name } = profile;
  const loginWorkspace =
    workspace.workspaceId ?? sdkSetting(env[LOGIN_WORKSPACE_VARIABLE]) ?? profile.workspaceId;
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
