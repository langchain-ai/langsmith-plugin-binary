import { win32 } from "node:path";
import { MACOS_PLATFORM, WINDOWS_PLATFORM } from "../constants.js";
import { spawnDetached } from "../process.js";
import { findExecutable } from "./launch.js";
import {
  DESKTOP_LINUX_END_OF_OPTIONS,
  DESKTOP_LINUX_NOTIFIER,
  DESKTOP_MESSAGE_VARIABLE,
  DESKTOP_NOTIFIER,
  DESKTOP_NOTIFIER_SCRIPT,
  DESKTOP_TITLE_VARIABLE,
  DESKTOP_WINDOWS_NOTIFIER_PATH,
  DESKTOP_WINDOWS_ROOT_DEFAULT,
  DESKTOP_WINDOWS_ROOT_VARIABLE,
  DESKTOP_WINDOWS_NOTIFIER_ARGUMENTS,
} from "./desktop-constants.js";
import type { DesktopCommand, DesktopLauncher } from "./models.js";

let launcher: DesktopLauncher = spawnDetached;

export function showDesktopNotification(
  title: string,
  message: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const notifier = desktopNotificationCommand(title, message, platform, env);
  return (
    notifier !== undefined && launcher(notifier.command, notifier.args, notifier.env) !== undefined
  );
}

export function setDesktopLauncherForTests(next: DesktopLauncher = spawnDetached): void {
  launcher = next;
}

export function desktopNotificationCommand(
  title: string,
  message: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): DesktopCommand | undefined {
  if (platform === MACOS_PLATFORM)
    return { command: DESKTOP_NOTIFIER, args: [...DESKTOP_NOTIFIER_SCRIPT, message, title], env };
  if (platform === WINDOWS_PLATFORM)
    return {
      command: win32.join(
        env[DESKTOP_WINDOWS_ROOT_VARIABLE] ?? DESKTOP_WINDOWS_ROOT_DEFAULT,
        ...DESKTOP_WINDOWS_NOTIFIER_PATH,
      ),
      args: DESKTOP_WINDOWS_NOTIFIER_ARGUMENTS,
      env: { ...env, [DESKTOP_TITLE_VARIABLE]: title, [DESKTOP_MESSAGE_VARIABLE]: message },
    };
  const notifier = findExecutable(DESKTOP_LINUX_NOTIFIER, env, platform);
  return notifier === undefined
    ? undefined
    : { command: notifier, args: [DESKTOP_LINUX_END_OF_OPTIONS, title, message], env };
}
