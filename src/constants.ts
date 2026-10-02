export const HEREDOC_TERMINATOR = "HELP";
export const MULTI_LINE_OR_CONTROL = /\p{Cc}/u;
export const EXECUTABLE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const REPOSITORY_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const DEFAULT_PUBLISHED_TARGETS: Readonly<Record<string, readonly string[]>> = {
  darwin: ["arm64", "x64"],
};

export const CRASH_SIGNALS: ReadonlySet<string> = new Set([
  "SIGABRT",
  "SIGBUS",
  "SIGEMT",
  "SIGFPE",
  "SIGILL",
  "SIGSEGV",
  "SIGSYS",
  "SIGTRAP",
]);

export const NODE_ERROR_PREFIX = "ERR_";

export const MACH_O_ARCHES: Readonly<Record<string, string>> = { arm64: "arm64", x64: "x86_64" };

export const VERSION_DEFINE = "__LS_INTEGRATION_VERSION__";

export const DEVELOPER_ID_PREFIX = "Developer ID Application:";
export const IDENTITY_LINE = /^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+"([^"]+)"$/gm;
export const TEAM_ID_SUFFIX = /\(([A-Z0-9]{10})\)$/;

export const APPLE_CREDENTIALS = [
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "CSC_KEY_PASSWORD",
  "CSC_LINK",
] as const;
