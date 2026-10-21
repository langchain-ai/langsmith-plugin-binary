export const POLICY_LOCK_TIMEOUT_MS = 2_000;
export const POLICY_LOCK_TIMEOUT_ERROR = "Timed out waiting for tracing preference lock";
export const POLICY_LOCK_TIMEOUT_MESSAGE =
  "Retry; if it persists, remove the lock only after confirming no preference writer is running.";
export const POLICY_UNREADABLE_MESSAGE =
  "Refusing to overwrite them; repair the file or its permissions before retrying. No preferences were changed.";
export const POLICY_NOT_REGULAR_MESSAGE = "Tracing preferences must be a regular, non-symlink file";
export const POLICY_ASYNC_UPDATE_MESSAGE = "A policy update must change the policy synchronously";
export const POLICY_FILE_MODE = 0o600;
export const POLICY_FILE_ENCODING = "utf8";
export const POLICY_TEMP_CREATE_FLAG = "wx";
export const POLICY_DIRECTORY_OPEN_FLAG = "r";
export const POLICY_WARNING_SEPARATOR = "; ";
export const POLICY_TEMP_CLOSE_WARNING = "Temporary file close failed";
export const POLICY_TEMP_CLEANUP_WARNING = "Temporary file cleanup failed";
export const POLICY_DIRECTORY_CLOSE_WARNING = "Directory close cleanup failed";
export const POLICY_LOCK_CLEANUP_FAILED_PREFIX = "Preference lock cleanup failed at";
export const POLICY_CANNOT_READ_PREFIX = "Cannot read tracing preferences at";
export const POLICY_DURABILITY_WARNING =
  "Preference is effective, but crash durability could not be confirmed; retry saving";
export const POLICY_LOCK_RELEASE_WARNING =
  "Before retrying, remove the lock only after confirming no preference writer is running";
export const COMPILED_BINARY_ENTRY_PREFIXES: readonly string[] = [
  "/$bunfs/",
  "B:/~BUN/",
  "B:\\~BUN\\",
];
export const WORKER_LOG_FILE_NAME = "worker.log";
export const WORKER_LOG_MODE = 0o600;
export const WORKER_LOG_MAX_BYTES = 1024 * 1024;
export const WORKER_LOG_APPEND_FLAG = "a";
export const WORKER_LOG_TRUNCATE_FLAG = "w";
export const SYSTEM_CERTIFICATES_FILE_NAME = "system_certificates.pem";
export const WORKER_NO_PID_MESSAGE = "Background worker did not report a process ID";
export const UNAVAILABLE_ACCOUNT_FINGERPRINT = "unavailable";
export const HOOK_HELP_FLAGS: readonly string[] = ["--help", "-h"];
export const HOOK_VERSION_FLAGS: readonly string[] = ["--version", "-v"];
export const POLICY_PARSE_RESULT_MESSAGE = "A policy parser must return a policy";
export const HOOK_OPTIONS_INVALID_MESSAGE =
  "Hook options need a hooks table and onHookError and onUnknown callbacks";
export const HOOK_ERROR_HANDLER_WARNING = "The hook error handler failed:";
export const NOTICE_DEFAULT_COOLDOWN_MINUTES = 2;
export const NOTICE_MINUTE_MS = 60_000;
export const NOTICE_OFF = "off";
export const NOTICE_STATE_FILE = "notices.json";
export const NOTICE_KEY_SEPARATOR = "\n";
