import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { shouldShowNotice } from "../plugin/notice-cooldown.js";
import { claimStateEntry } from "../storage/state-claim.js";
import { STATE_PRIVATE_DIR_MODE } from "../storage/state-constants.js";
import type { StateClaim } from "../storage/state-models.js";
import { createStateStore } from "../storage/state-store.js";
import { canOpenBrowser, findExecutable } from "../utils/desktop/launch.js";
import { launchDesktopCommand, showDesktopNotification } from "../utils/desktop/notification.js";
import { describe } from "../utils/errors.js";
import { WINDOWS_PLATFORM } from "../utils/constants.js";
import { fillTemplate } from "../utils/format.js";
import { LOGIN_CONFIG_FILE_ENCODING, LOGIN_HOME_VARIABLES } from "./constants.js";
import type { LoginProfile, UploadLogin } from "./models.js";
import { expiredMarkerPrefix, readLoginProfile, readProfileAt } from "./profile.js";
import {
  LOGIN_BROWSER_CODE_NOTICE,
  LOGIN_BROWSER_NOTICE,
  LOGIN_CLI_API_URL_FLAG,
  LOGIN_CLI_ARGUMENTS,
  LOGIN_CLI_CODE_PATTERN,
  LOGIN_CLI_HOME_FOLDERS,
  LOGIN_CLI_MISSING_NOTICE,
  LOGIN_CLI_MISSING_WINDOWS_NOTICE,
  LOGIN_CLI_NAME,
  LOGIN_CLI_PROFILE_FLAG,
  LOGIN_CLI_SYSTEM_FOLDERS,
  LOGIN_CLI_TIMEOUT_FLAG,
  LOGIN_CLI_WAITING_PATTERN,
  LOGIN_CLEANUP_WARNING,
  LOGIN_CLI_WINDOWS_FOLDER,
  LOGIN_CLI_WINDOWS_ROOT_VARIABLE,
  LOGIN_CODE_FILE_FLAG,
  LOGIN_CODE_FILE_MODE,
  LOGIN_CODE_POLL_MS,
  LOGIN_CODE_WAIT_MS,
  LOGIN_MARKER_WARNING,
  LOGIN_KEY_REJECTED_ENTRY,
  LOGIN_KEY_REJECTED_NOTICE,
  LOGIN_NOTICE_KIND,
  LOGIN_NOTIFICATION_TITLE,
  LOGIN_PAUSED_NOTICE,
  LOGIN_RENEWAL_WARNING,
  LOGIN_SIGN_IN_LIFETIME,
  LOGIN_SIGN_IN_LIFETIME_MS,
  LOGIN_STATE_FILE,
  LOGIN_STATE_SUBFOLDER,
} from "./renewal-constants.js";
import type { LoginClaim, LoginRenewalOptions, LoginRenewalResult } from "./renewal-models.js";

const unrecorded = new Set<string>();

export async function renewRejectedLogin(
  login: UploadLogin,
  apiUrl: string,
  sentTokenHash: string,
  options: LoginRenewalOptions = {},
): Promise<LoginRenewalResult> {
  try {
    return await renewLogin(login, apiUrl, sentTokenHash, options);
  } catch (error) {
    console.warn(LOGIN_RENEWAL_WARNING, describe(error));
    return "notice";
  }
}

async function renewLogin(
  login: UploadLogin,
  apiUrl: string,
  sentTokenHash: string,
  options: LoginRenewalOptions,
): Promise<LoginRenewalResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const profile = readProfileAt(login.configPath, login.profile);
  if (profile === undefined || profile.tokenHash !== sentTokenHash) return "superseded";
  const key = `${expiredMarkerPrefix(profile)}${profile.tokenHash}`;
  const claim = await claimLogin(profile, key, options.storageRoot);
  if (claim === "existing") return "already-handled";
  if (claim === "unrecorded" && unrecorded.has(key)) return "already-handled";
  if (claim === "unrecorded") unrecorded.add(key);
  const folders = options.cliFolders ?? loginCliFolders(env);
  const cli = findExecutable(LOGIN_CLI_NAME, env, platform, folders);
  if (
    claim === "unrecorded" ||
    cli === undefined ||
    options.browser === false ||
    !canOpenBrowser(env, platform)
  ) {
    const missing =
      platform === WINDOWS_PLATFORM ? LOGIN_CLI_MISSING_WINDOWS_NOTICE : LOGIN_CLI_MISSING_NOTICE;
    return tell(cli === undefined ? missing : LOGIN_PAUSED_NOTICE, "notice");
  }
  const codeFile = join(options.storageRoot!, LOGIN_STATE_SUBFOLDER, key);
  mkdirSync(join(options.storageRoot!, LOGIN_STATE_SUBFOLDER), {
    recursive: true,
    mode: STATE_PRIVATE_DIR_MODE,
  });
  const output = openSync(codeFile, LOGIN_CODE_FILE_FLAG, LOGIN_CODE_FILE_MODE);
  const args = [...LOGIN_CLI_ARGUMENTS, LOGIN_CLI_API_URL_FLAG, apiUrl, LOGIN_CLI_TIMEOUT_FLAG];
  const pid = launchDesktopCommand(
    cli,
    [...args, LOGIN_SIGN_IN_LIFETIME, LOGIN_CLI_PROFILE_FLAG, login.profile],
    env,
    output,
  );
  closeSync(output);
  if (pid === undefined) return tell(LOGIN_PAUSED_NOTICE, "notice");
  const code = await waitForCode(codeFile);
  return tell(
    code === undefined ? LOGIN_BROWSER_NOTICE : fillTemplate(LOGIN_BROWSER_CODE_NOTICE, { code }),
    "browser",
  );

  async function tell(notice: string, result: LoginRenewalResult): Promise<LoginRenewalResult> {
    await announce(notice, options);
    return result;
  }
}

export async function recordRejectedKey(options: LoginRenewalOptions): Promise<void> {
  if (options.storageRoot === undefined) return;
  const path = join(options.storageRoot, LOGIN_STATE_FILE);
  try {
    if (!(await claimStateEntry(path, LOGIN_KEY_REJECTED_ENTRY, Infinity))) return;
  } catch {
    return;
  }
  await announce(LOGIN_KEY_REJECTED_NOTICE, options);
}

export async function clearRejectedKey(storageRoot: string | undefined): Promise<void> {
  if (storageRoot !== undefined) await clearMarkers(storageRoot, LOGIN_KEY_REJECTED_ENTRY);
}

async function announce(notice: string, options: LoginRenewalOptions): Promise<void> {
  console.warn(notice);
  const { notify, storageRoot } = options;
  if (notify === undefined) return;
  const shown =
    storageRoot === undefined ||
    (await shouldShowNotice({ ...notify, kind: LOGIN_NOTICE_KIND, storageRoot }));
  if (shown)
    showDesktopNotification(
      LOGIN_NOTIFICATION_TITLE,
      notice,
      options.platform ?? process.platform,
      options.env ?? process.env,
    );
}

export function readLoginNotice(
  storageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const saved = loginStore(storageRoot).read();
  if (saved[LOGIN_KEY_REJECTED_ENTRY] !== undefined) return LOGIN_KEY_REJECTED_NOTICE;
  const profile = readLoginProfile(env);
  if (profile === undefined) return undefined;
  const key = `${expiredMarkerPrefix(profile)}${profile.tokenHash}`;
  if (unrecorded.has(key)) return LOGIN_PAUSED_NOTICE;
  if (saved[key] === undefined) return undefined;
  const codeFile = join(storageRoot, LOGIN_STATE_SUBFOLDER, key);
  const output = readCodeFile(codeFile) ?? "";
  const running =
    LOGIN_CLI_WAITING_PATTERN.test(output) &&
    Date.now() - modifiedAt(codeFile) < LOGIN_SIGN_IN_LIFETIME_MS;
  const code = running ? LOGIN_CLI_CODE_PATTERN.exec(output)?.[1] : undefined;
  return code === undefined
    ? LOGIN_PAUSED_NOTICE
    : fillTemplate(LOGIN_BROWSER_CODE_NOTICE, { code });
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

async function forgetLogins(storageRoot: string, prefix: string, keep: string | undefined) {
  const forget = (key: string) => key.startsWith(prefix) && key !== keep;
  const store = loginStore(storageRoot);
  if (Object.keys(store.read()).some(forget))
    await store.update((state) =>
      Object.fromEntries(Object.entries(state).filter(([key]) => !forget(key))),
    );
  try {
    const folder = join(storageRoot, LOGIN_STATE_SUBFOLDER);
    for (const name of readdirSync(folder)) if (forget(name)) unlinkSync(join(folder, name));
  } catch {}
}

function loginStore(storageRoot: string) {
  return createStateStore<StateClaim>({
    path: join(storageRoot, LOGIN_STATE_FILE),
    warn: () => undefined,
  });
}

function loginCliFolders(env: NodeJS.ProcessEnv): string[] {
  const home = LOGIN_HOME_VARIABLES.map((name) => env[name]).find(Boolean);
  const windowsRoot = env[LOGIN_CLI_WINDOWS_ROOT_VARIABLE];
  return [
    ...(home === undefined ? [] : LOGIN_CLI_HOME_FOLDERS.map((folder) => join(home, folder))),
    ...(windowsRoot === undefined ? [] : [join(windowsRoot, LOGIN_CLI_WINDOWS_FOLDER)]),
    ...LOGIN_CLI_SYSTEM_FOLDERS,
  ];
}

async function waitForCode(marker: string): Promise<string | undefined> {
  for (const deadline = Date.now() + LOGIN_CODE_WAIT_MS; Date.now() < deadline;) {
    const code = LOGIN_CLI_CODE_PATTERN.exec(readCodeFile(marker) ?? "")?.[1];
    if (code !== undefined) return code;
    await delay(LOGIN_CODE_POLL_MS);
  }
  return undefined;
}

function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readCodeFile(path: string): string | undefined {
  try {
    return readFileSync(path, LOGIN_CONFIG_FILE_ENCODING);
  } catch {
    return undefined;
  }
}
