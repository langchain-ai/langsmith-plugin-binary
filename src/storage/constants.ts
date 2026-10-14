import {
  FILE_ACCESS_DENIED_CODE,
  FILE_BUSY_CODE,
  PERMISSION_DENIED_CODE,
} from "../utils/constants.js";

export const FILE_LOCK_CLAIM_VERSION = 1;
export const FILE_LOCK_CLAIM_EXTENSION = ".json";
export const FILE_LOCK_DIRECTORY_SUFFIX = ".claims";
export const FILE_LOCK_LEGACY_DIRECTORY_SUFFIX = ".lock";
export const FILE_LOCK_TIMEOUT_ERROR_NAME = "FileLockTimeoutError";
export const FILE_LOCK_TEMP_PREFIX = ".";
export const FILE_LOCK_TEMP_SUFFIX = ".tmp";
export const FILE_LOCK_EXCLUSIVE_FLAG = "wx";
export const FILE_LOCK_ENCODING = "utf-8";
export const FILE_LOCK_DEFAULT_TIMEOUT_MS = 5_000;
export const FILE_LOCK_POLL_INTERVAL_MS = 10;
export const FILE_LOCK_DIRECTORY_MODE = 0o700;
export const FILE_LOCK_FILE_MODE = 0o600;
export const FILE_LOCK_UNSELECTED_TICKET = 0;
export const FILE_LOCK_NEGATIVE_TICKET_LIMIT = 0;
export const FILE_LOCK_TIMEOUT_MESSAGE = "Timed out waiting for file lock";
export const FILE_LOCK_TICKET_LIMIT_MESSAGE = "File lock ticket limit reached";
export const FILE_LOCK_RELEASE_MESSAGE = "Could not release file lock claim";
export const FILE_LOCK_INVALID_TIMEOUT_MESSAGE = "timeoutMs must be a finite positive number";
export const FILE_LOCK_ACQUIRE_MESSAGE = "Could not acquire file lock claim";
export const FILE_LOCK_UNSAFE_DIRECTORY_MESSAGE = "Unsafe file lock claims directory";
export const FILE_LOCK_RENAME_RETRY_TIMEOUT_MS = 100;
export const FILE_LOCK_HEARTBEAT_MS = 500;
export const FILE_LOCK_STALE_CLAIM_MS = 3_000;
export const FILE_LOCK_TRY_CHOOSING_WAIT_MS = 1_000;
export const FILE_LOCK_DIRECTORY_CONTENTION_CODES: readonly string[] = [
  PERMISSION_DENIED_CODE,
  FILE_ACCESS_DENIED_CODE,
];
export const FILE_LOCK_BUSY_FILE_CODES: readonly string[] = [
  ...FILE_LOCK_DIRECTORY_CONTENTION_CODES,
  FILE_BUSY_CODE,
];
export const FILE_LOCK_HEARTBEAT_WARNING = "Could not refresh a file lock claim:";
export const FILE_LOCK_COMPATIBLE_ACQUIRE_CLEANUP_MESSAGE =
  "Could not release the legacy lock gate after shared lock acquisition failed";
export const FILE_LOCK_COMPATIBLE_RELEASE_MESSAGE = "Could not release compatible file lock";
export const FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE =
  "Legacy file lock gate changed before release";
export const FILE_LOCK_COMPATIBLE_OWNER_FILE = "owner";
export const FILE_LOCK_COMPATIBLE_OWNER_MESSAGE =
  "Could not record the legacy file lock gate owner";
export const FILE_LOCK_COMPATIBLE_OWNER_PID_PATTERN = /^[1-9]\d*$/u;
export const FILE_LOCK_COMPATIBLE_ABANDONED_GATE_MS = 5_000;
export const FILE_LOCK_COMPATIBLE_STALE_SUFFIX = ".stale";
export const FILE_LOCK_GATE_CLEANUP_WARNING = "Could not remove a half-created lock folder:";
export const FILE_LOCK_STALE_GATE_CLEANUP_WARNING = "Could not remove an old lock folder:";
export const STORAGE_STALE_FILE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const STORAGE_STALE_DIRECTORY_WARNING = "Could not remove an old empty folder:";
export const STORAGE_STALE_REMOVAL_WARNING = "Removed an old leftover file:";
export const FILE_LOCK_LOST_MESSAGE = "The file lock was taken over before the write finished";
const STORAGE_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const STORAGE_ENGINE_FILE_PATTERNS: readonly RegExp[] = [
  new RegExp(`^\\.${STORAGE_UUID}(\\.${STORAGE_UUID})?\\.tmp$`, "u"),
  new RegExp(`^wake\\.active\\.${STORAGE_UUID}(\\.attempt\\.[1-9]\\d*)?\\.json$`, "u"),
  /^wake\.launching$/u,
];
export const STORAGE_CLAIM_FILE = new RegExp(`^${STORAGE_UUID}\\.json$`, "u");
export const STORAGE_LEGACY_RECEIPTS_DIRECTORY = "receipts";
export const STORAGE_LEGACY_ATTEMPTS_DIRECTORY = "attempts";
export const STORAGE_LEGACY_RECEIPT_FILE = /^[0-9a-f]{64}\.json$/u;
export const STORAGE_LEGACY_ATTEMPT_FILE = /^[1-9]\d*\.json$/u;
