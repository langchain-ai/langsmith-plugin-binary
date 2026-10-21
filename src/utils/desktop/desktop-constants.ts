export const DESKTOP_SSH_VARIABLES = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;
export const DESKTOP_DISPLAY_VARIABLES = ["DISPLAY", "WAYLAND_DISPLAY"] as const;
export const DESKTOP_WINDOWED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "win32"];
export const DESKTOP_NOTIFIER = "/usr/bin/osascript";
export const DESKTOP_NOTIFIER_SCRIPT = [
  "-e",
  "on run argv",
  "-e",
  "display notification (item 1 of argv) with title (item 2 of argv)",
  "-e",
  "end run",
] as const;
export const DESKTOP_WINDOWS_EXTENSIONS = ".EXE;.CMD;.BAT";
export const DESKTOP_WINDOWS_SEPARATOR = ";";
export const DESKTOP_PATH_SEPARATOR = ":";
export const DESKTOP_PATH_VARIABLES = ["PATH", "Path"] as const;
export const DESKTOP_EXTENSIONS_VARIABLE = "PATHEXT";
export const DESKTOP_LINUX_NOTIFIER = "notify-send";
export const DESKTOP_LINUX_END_OF_OPTIONS = "--";
export const DESKTOP_WINDOWS_ROOT_VARIABLE = "SystemRoot";
export const DESKTOP_WINDOWS_ROOT_DEFAULT = "C:\\Windows";
export const DESKTOP_WINDOWS_NOTIFIER_PATH = [
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
] as const;
export const DESKTOP_TITLE_VARIABLE = "LANGSMITH_NOTIFICATION_TITLE";
export const DESKTOP_MESSAGE_VARIABLE = "LANGSMITH_NOTIFICATION_MESSAGE";
export const DESKTOP_WINDOWS_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
export const DESKTOP_WINDOWS_TOAST_SCRIPT = [
  "$m = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "$t = $m::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$x = $t.GetElementsByTagName('text')",
  `[void]$x.Item(0).AppendChild($t.CreateTextNode($env:${DESKTOP_TITLE_VARIABLE}))`,
  `[void]$x.Item(1).AppendChild($t.CreateTextNode($env:${DESKTOP_MESSAGE_VARIABLE}))`,
  `$m::CreateToastNotifier('${DESKTOP_WINDOWS_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
].join("; ");
export const DESKTOP_WINDOWS_NOTIFIER_ARGUMENTS = [
  "-NoProfile",
  "-NonInteractive",
  "-WindowStyle",
  "Hidden",
  "-Command",
  DESKTOP_WINDOWS_TOAST_SCRIPT,
] as const;
