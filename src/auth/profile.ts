import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sdkProfileValue, sdkSetting } from "../utils/sdk/normalize.js";
import { isPlainRecord } from "../utils/validation/objects.js";
import {
  LOGIN_CONFIG_DIRECTORY,
  LOGIN_CONFIG_FILE_NAME,
  LOGIN_CONFIG_KEYS,
  LOGIN_CONFIG_FILE_VARIABLE,
  LOGIN_DEFAULT_API_URL,
  LOGIN_DEFAULT_PROFILE,
  LOGIN_CONFIG_FILE_ENCODING,
  LOGIN_EXPIRED_MARKER_PREFIX,
  LOGIN_HOME_VARIABLES,
  LOGIN_PROFILE_VARIABLE,
  LOGIN_TOKEN_HASH,
  LOGIN_TOKEN_HASH_LENGTH,
  LOGIN_URL_TRAILING_PATTERN,
} from "./constants.js";
import type { LoginProfile, UploadLogin } from "./models.js";

export function readLoginProfile(env: NodeJS.ProcessEnv): LoginProfile | undefined {
  const configPath = loginConfigPath(env);
  return configPath === undefined
    ? undefined
    : readProfileAt(configPath, env[LOGIN_PROFILE_VARIABLE] || undefined);
}

export function readProfileAt(configPath: string, name?: string): LoginProfile | undefined {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, LOGIN_CONFIG_FILE_ENCODING));
  } catch {
    return undefined;
  }
  if (!isPlainRecord(config)) return undefined;
  const profiles = config[LOGIN_CONFIG_KEYS.profiles];
  const current = config[LOGIN_CONFIG_KEYS.currentProfile];
  if (!isPlainRecord(profiles)) return undefined;
  const profile =
    name ??
    (typeof current === "string" ? current || undefined : undefined) ??
    (Object.hasOwn(profiles, LOGIN_DEFAULT_PROFILE) ? LOGIN_DEFAULT_PROFILE : undefined);
  const entry =
    profile !== undefined && Object.hasOwn(profiles, profile) ? profiles[profile] : undefined;
  if (profile === undefined || !isPlainRecord(entry)) return undefined;
  const credentials = entry[LOGIN_CONFIG_KEYS.oauth];
  const oauth = isPlainRecord(credentials) ? credentials : {};
  const secret =
    sdkProfileValue(oauth[LOGIN_CONFIG_KEYS.refreshToken]) ??
    sdkProfileValue(oauth[LOGIN_CONFIG_KEYS.accessToken]) ??
    sdkProfileValue(entry[LOGIN_CONFIG_KEYS.apiKey]);
  if (secret === undefined) return undefined;
  const accessToken = sdkProfileValue(oauth[LOGIN_CONFIG_KEYS.accessToken]);
  const workspaceId = sdkSetting(entry[LOGIN_CONFIG_KEYS.workspaceId]);
  return {
    configPath,
    profile,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    apiUrl: sdkSetting(entry[LOGIN_CONFIG_KEYS.apiUrl]) ?? LOGIN_DEFAULT_API_URL,
    tokenHash: credentialHash(secret),
    ...(accessToken === undefined ? {} : { accessTokenHash: credentialHash(accessToken) }),
  };
}

export function loginTokenHash(login: UploadLogin): string | undefined {
  return readProfileAt(login.configPath, login.profile)?.tokenHash;
}

export function expiredMarkerPrefix(login: UploadLogin): string {
  return `${LOGIN_EXPIRED_MARKER_PREFIX}${credentialHash(`${login.configPath}\n${login.profile}`)}.`;
}

export function sameServer(left: string, right: string): boolean {
  return serverKey(left) === serverKey(right);
}

export function serverKey(value: string): string {
  try {
    const url = new URL(sdkSetting(value) ?? "");
    return `${url.origin}${url.pathname.replace(LOGIN_URL_TRAILING_PATTERN, "")}`;
  } catch {
    return value;
  }
}

function loginConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env[LOGIN_CONFIG_FILE_VARIABLE];
  if (explicit) return explicit;
  const home = LOGIN_HOME_VARIABLES.map((name) => env[name]).find((value) => value !== undefined);
  return home ? join(home, LOGIN_CONFIG_DIRECTORY, LOGIN_CONFIG_FILE_NAME) : undefined;
}

export function credentialHash(value: string): string {
  return createHash(LOGIN_TOKEN_HASH).update(value).digest("hex").slice(0, LOGIN_TOKEN_HASH_LENGTH);
}
