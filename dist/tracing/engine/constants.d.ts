export declare const TRACING_ENGINE_FOREIGN_SESSION_MIN_AGE_MS: number;
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_COOLDOWN_MS: number;
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_DIRECTORY = "background-recovery";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_INTEGRATIONS_DIRECTORY = "integrations";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_ACCOUNTS_DIRECTORY = "accounts";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_LOCK_FILE = "scan.lock";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_FILE = "cooldown.json";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_VERSION: 1;
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_EXISTS_ERROR = "Background recovery cooldown marker is already published";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_RETRY_RANGE_ERROR = "Background recovery retry time is outside the supported range";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_REPORT_ERROR = "Background recovery report callback failed";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_FILE_NOT_FOUND_CODE = "ENOENT";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_SESSION_CALLBACK_ERROR = "Background recovery session callback is required";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_REPORT_CALLBACK_ERROR = "Background recovery report callback is required";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_MINIMUM_AGE_ERROR = "Minimum foreign session age must be a non-negative integer";
export declare const TRACING_ENGINE_BACKGROUND_RECOVERY_COOLDOWN_RANGE_ERROR = "Background recovery cooldown must be a positive integer";
//# sourceMappingURL=constants.d.ts.map