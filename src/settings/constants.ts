import { constants } from "node:fs";

export const COMMON_BOOLEAN_SETTINGS = {
  enabled: { default: false, restrictive: false },
  defaultMuted: { default: false, restrictive: true },
} as const;

export const COMMON_CONFIG_FILE_NAME = "langsmith.json";
export const COMMON_CONFIG_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
export const COMMON_CONFIG_ROOT_FILE_NAME = "langsmith-plugins.json";
export const COMMON_CONFIG_USER_ROOT_FILE_NAME = ".langsmith-plugins.json";

export const MANAGED_CONFIG_DIRECTORY = ".langsmith-plugins";

export const MANAGED_CONFIG_FILE_NAME = "managed.json";

export const MANAGED_CONFIG_OPEN_FLAGS = COMMON_CONFIG_OPEN_FLAGS | (constants.O_NOFOLLOW ?? 0);

export const MANAGED_CONFIG_OWNER_UID = 0;

export const GROUP_OR_OTHERS_WRITE_BITS = 0o022;

export const MANAGED_CONFIG_OVERRIDE_SOURCES = [
  "env",
  "harness",
  "root",
  "user",
  "userRoot",
] as const;

export const MANAGED_CONFIG_UNSAFE_OWNERSHIP =
  "Managed config for LangSmith is not owned by root, is writable by other users, or is a symlink. This session's trace will not be captured. Please contact an admin to troubleshoot.";

export const MANAGED_CONFIG_INVALID =
  "Managed config for LangSmith tracing is unreadable or invalid so this session's trace will not be captured. Contact an admin to troubleshoot.";

export const MANAGED_CONFIG_OVERRIDE_WARNING =
  "Ignored settings the managed config locks: {overrides}.";
export const MANAGED_CONFIG_OVERRIDE_FIELD_SEPARATOR = "; ";
export const MANAGED_CONFIG_OVERRIDE_SOURCE_SEPARATOR = ", ";

export const ACCOUNT_LOOKUP_TIMEOUT_MS = 2_000;
export const MACOS_ACCOUNT_LOOKUP = "/usr/bin/id";
export const MACOS_ACCOUNT_LOOKUP_ARGUMENTS = ["-P"];
export const MACOS_ACCOUNT_HOME_FIELD = 8;
export const LINUX_ACCOUNT_LIST_FILE = "/etc/passwd";
export const LINUX_ACCOUNT_LOOKUPS = ["/usr/bin/getent", "/bin/getent"];
export const LINUX_ACCOUNT_HOME_FIELD = 5;
export const ACCOUNT_ID_FIELD = 2;
export const ACCOUNT_FIELD_SEPARATOR = ":";

export const UTF8_BOM = /^\uFEFF/;
