import { constants } from "node:fs";
export const COMMON_BOOLEAN_SETTINGS = {
    enabled: { default: false, restrictive: false },
    defaultMuted: { default: false, restrictive: true },
};
export const COMMON_CONFIG_FILE_NAME = "langsmith.json";
export const COMMON_CONFIG_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
export const COMMON_CONFIG_ROOT_FILE_NAME = "langsmith-plugins.json";
export const COMMON_CONFIG_USER_ROOT_FILE_NAME = ".langsmith-plugins.json";
export const MANAGED_CONFIG_DIRECTORY = ".langsmith-plugins";
export const MANAGED_CONFIG_FILE_NAME = "managed.json";
export const MANAGED_CONFIG_OPEN_FLAGS = COMMON_CONFIG_OPEN_FLAGS | (constants.O_NOFOLLOW ?? 0);
export const MANAGED_CONFIG_OWNER_UID = 0;
export const MANAGED_CONFIG_UNSAFE_MODE = 0o022;
export const LOCKABLE_FIELDS = [
    "api_url",
    "replicas",
    "redact",
    "redact_extra_rules",
];
export const MANAGED_CONFIG_OVERRIDE_SOURCES = [
    "env",
    "harness",
    "root",
    "user",
    "userRoot",
];
export const MANAGED_CONFIG_UNTRUSTED = "Managed config is not owned by root, is writable by other users, or is a symlink; tracing is off until an admin fixes it.";
export const MANAGED_CONFIG_INVALID = "Managed config is unreadable or invalid; tracing is off until an admin fixes it.";
export const MANAGED_CONFIG_IGNORED_KEYS = `Ignored keys in managed config that cannot be locked; only ${LOCKABLE_FIELDS.join(", ")} can be locked.`;
export const UTF8_BOM = /^\uFEFF/;
//# sourceMappingURL=constants.js.map