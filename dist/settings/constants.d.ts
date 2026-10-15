import type { LockableField } from "./models.js";
export declare const COMMON_BOOLEAN_SETTINGS: {
    readonly enabled: {
        readonly default: false;
        readonly restrictive: false;
    };
    readonly defaultMuted: {
        readonly default: false;
        readonly restrictive: true;
    };
};
export declare const COMMON_CONFIG_FILE_NAME = "langsmith.json";
export declare const COMMON_CONFIG_OPEN_FLAGS: number;
export declare const COMMON_CONFIG_ROOT_FILE_NAME = "langsmith-plugins.json";
export declare const COMMON_CONFIG_USER_ROOT_FILE_NAME = ".langsmith-plugins.json";
export declare const MANAGED_CONFIG_DIRECTORY = ".langsmith-plugins";
export declare const MANAGED_CONFIG_FILE_NAME = "managed.json";
export declare const MANAGED_CONFIG_OPEN_FLAGS: number;
export declare const MANAGED_CONFIG_OWNER_UID = 0;
export declare const MANAGED_CONFIG_UNSAFE_MODE = 18;
export declare const LOCKABLE_FIELDS: readonly LockableField[];
export declare const MANAGED_CONFIG_OVERRIDE_SOURCES: readonly ["env", "harness", "root", "user", "userRoot"];
export declare const MANAGED_CONFIG_UNTRUSTED = "Managed config is not owned by root, is writable by other users, or is a symlink; tracing is off until an admin fixes it.";
export declare const MANAGED_CONFIG_INVALID = "Managed config is unreadable or invalid; tracing is off until an admin fixes it.";
export declare const MANAGED_CONFIG_IGNORED_KEYS: string;
export declare const UTF8_BOM: RegExp;
//# sourceMappingURL=constants.d.ts.map