export { dispatchHookCommand } from "./hook-command.js";
export { readPolicyFile, updatePolicyFile } from "./policy-file.js";
export { openPluginSession } from "./session.js";
export { launchDetachedWorker } from "./worker-launch.js";
export { shouldShowNotice } from "./notice-cooldown.js";
export {
  setDesktopLauncherForTests,
  showDesktopNotification,
} from "../utils/desktop/notification.js";
export type { DesktopLauncher } from "../utils/desktop/models.js";
export type {
  DetachedWorkerOptions,
  HookCommandOptions,
  HookRunner,
  NoticeOptions,
  PluginSession,
  PluginSessionOptions,
  PolicyFileOptions,
  PolicyUpdateResult,
} from "./models.js";
