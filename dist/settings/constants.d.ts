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
export declare const GROUP_OR_OTHERS_WRITE_BITS = 18;
export declare const MANAGED_CONFIG_OVERRIDE_SOURCES: readonly ["env", "harness", "root", "user", "userRoot"];
export declare const MANAGED_CONFIG_UNSAFE_OWNERSHIP = "Managed config for LangSmith is not owned by root, is writable by other users, or is a symlink. This session's trace will not be captured. Please contact an admin to troubleshoot.";
export declare const MANAGED_CONFIG_INVALID = "Managed config for LangSmith tracing is unreadable or invalid so this session's trace will not be captured. Contact an admin to troubleshoot.";
export declare const MANAGED_CONFIG_OVERRIDE_WARNING = "Ignored settings the managed config locks: {overrides}.";
export declare const MANAGED_CONFIG_OVERRIDE_FIELD_SEPARATOR = "; ";
export declare const MANAGED_CONFIG_OVERRIDE_SOURCE_SEPARATOR = ", ";
export declare const ACCOUNT_LOOKUP_TIMEOUT_MS = 2000;
export declare const MACOS_ACCOUNT_LOOKUP = "/usr/bin/id";
export declare const MACOS_ACCOUNT_LOOKUP_ARGUMENTS: string[];
export declare const MACOS_ACCOUNT_HOME_FIELD = 8;
export declare const LINUX_ACCOUNT_LIST_FILE = "/etc/passwd";
export declare const LINUX_ACCOUNT_LOOKUPS: string[];
export declare const LINUX_ACCOUNT_HOME_FIELD = 5;
export declare const ACCOUNT_ID_FIELD = 2;
export declare const ACCOUNT_FIELD_SEPARATOR = ":";
export declare const UTF8_BOM: RegExp;
//# sourceMappingURL=constants.d.ts.map