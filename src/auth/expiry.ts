import { join } from "node:path";
import { claimStateEntry } from "../storage/state-claim.js";
import type { StateClaim } from "../storage/state-models.js";
import { createStateStore } from "../storage/state-store.js";
import { describe } from "../utils/errors.js";
import { sdkSetting } from "../utils/sdk/normalize.js";
import type { LoginProfile, UploadLogin } from "./models.js";
import { credentialHash, expiredMarkerPrefix, readLoginProfile, readProfileAt } from "./profile.js";
import {
  LOGIN_CLEANUP_WARNING,
  LOGIN_KEY_REJECTED_ENTRY,
  LOGIN_KEY_REJECTED_NOTICE,
  LOGIN_MARKER_WARNING,
  LOGIN_PAUSED_NOTICE,
  LOGIN_STATE_FILE,
} from "./expiry-constants.js";
import type { LoginClaim, LoginExpiryResult } from "./expiry-models.js";

const unrecorded = new Set<string>();

export async function recordExpiredLogin(
  login: UploadLogin,
  sentTokenHash: string | undefined,
  storageRoot: string | undefined,
): Promise<LoginExpiryResult> {
  try {
    const profile = readProfileAt(login.configPath, login.profile);
    if (profile === undefined || profile.accessTokenHash !== sentTokenHash) return "superseded";
    const key = `${expiredMarkerPrefix(profile)}${profile.tokenHash}`;
    const claim = await claimLogin(profile, key, storageRoot);
    if (claim === "existing" || (claim === "unrecorded" && unrecorded.has(key)))
      return "already-handled";
    if (claim === "unrecorded") unrecorded.add(key);
  } catch (error) {
    console.warn(LOGIN_MARKER_WARNING, describe(error));
  }
  console.warn(LOGIN_PAUSED_NOTICE);
  return "notice";
}

export async function recordRejectedKey(
  apiKey: string,
  storageRoot: string | undefined,
): Promise<void> {
  if (storageRoot === undefined) return;
  const path = join(storageRoot, LOGIN_STATE_FILE);
  try {
    if (!(await claimStateEntry(path, rejectedKeyEntry(apiKey), Infinity))) return;
  } catch {
    return;
  }
  console.warn(LOGIN_KEY_REJECTED_NOTICE);
}

export async function clearRejectedKey(
  storageRoot: string | undefined,
  apiKey?: string,
): Promise<void> {
  const entry = apiKey === undefined ? LOGIN_KEY_REJECTED_ENTRY : rejectedKeyEntry(apiKey);
  if (storageRoot !== undefined) await clearMarkers(storageRoot, entry);
}

export function readLoginNotice(
  storageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  apiKey?: string,
): string | undefined {
  const saved = loginStore(storageRoot).read();
  if (apiKey !== undefined)
    return saved[rejectedKeyEntry(apiKey)] === undefined ? undefined : LOGIN_KEY_REJECTED_NOTICE;
  const profile = readLoginProfile(env);
  if (profile === undefined) return undefined;
  const key = `${expiredMarkerPrefix(profile)}${profile.tokenHash}`;
  return unrecorded.has(key) || saved[key] !== undefined ? LOGIN_PAUSED_NOTICE : undefined;
}

export async function clearLoginExpiry(
  login: UploadLogin,
  storageRoot: string | undefined,
): Promise<void> {
  const prefix = expiredMarkerPrefix(login);
  for (const key of unrecorded) if (key.startsWith(prefix)) unrecorded.delete(key);
  if (storageRoot !== undefined) await clearMarkers(storageRoot, prefix);
}

async function clearMarkers(storageRoot: string, prefix: string): Promise<void> {
  try {
    await forgetLogins(storageRoot, prefix, undefined);
  } catch (error) {
    console.warn(LOGIN_CLEANUP_WARNING, describe(error));
  }
}

async function claimLogin(
  profile: LoginProfile,
  key: string,
  storageRoot: string | undefined,
): Promise<LoginClaim> {
  if (storageRoot === undefined) return "unrecorded";
  try {
    if (!(await claimStateEntry(join(storageRoot, LOGIN_STATE_FILE), key, Infinity)))
      return "existing";
  } catch (error) {
    console.warn(LOGIN_MARKER_WARNING, describe(error));
    return "unrecorded";
  }
  await forgetLogins(storageRoot, expiredMarkerPrefix(profile), key);
  return "claimed";
}

function rejectedKeyEntry(apiKey: string): string {
  return `${LOGIN_KEY_REJECTED_ENTRY}${credentialHash(sdkSetting(apiKey) ?? apiKey)}`;
}

async function forgetLogins(storageRoot: string, prefix: string, keep: string | undefined) {
  const forget = (key: string) => key.startsWith(prefix) && key !== keep;
  const store = loginStore(storageRoot);
  if (Object.keys(store.read()).some(forget))
    await store.update((state) =>
      Object.fromEntries(Object.entries(state).filter(([key]) => !forget(key))),
    );
}

function loginStore(storageRoot: string) {
  return createStateStore<StateClaim>({
    path: join(storageRoot, LOGIN_STATE_FILE),
    warn: () => undefined,
  });
}
