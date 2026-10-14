export const BACKGROUND_WORKER_DIRECTORY = "background-worker";
export const BACKGROUND_WORKER_INTEGRATIONS_DIRECTORY = "integrations";
export const BACKGROUND_WORKER_SESSIONS_DIRECTORY = "sessions";
export const BACKGROUND_WORKER_ACCOUNTS_DIRECTORY = "accounts";
export const BACKGROUND_WORKER_LOCK_FILE = "worker";
export const BACKGROUND_WORKER_PENDING_FILE = "wake.pending";
export const BACKGROUND_WORKER_ACTIVE_PREFIX = "wake.active.";
export const BACKGROUND_WORKER_LAUNCHING_FILE = "wake.launching";
export const BACKGROUND_WORKER_STAGING_FILE = /^\.[0-9a-f-]{36}\.tmp$/u;
export const BACKGROUND_WORKER_MARKER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const BACKGROUND_WORKER_ACTIVE_MARKER_NAME = /^wake\.active\.([0-9a-f-]{36})\.json$/u;
export const BACKGROUND_WORKER_ATTEMPT_NAME =
  /^wake\.active\.([0-9a-f-]{36})\.attempt\.([1-9]\d*)\.json$/u;
export const BACKGROUND_WORKER_MARKER_VERSION = 1;
export const BACKGROUND_WORKER_ATTEMPT_VERSION = 1;
export const BACKGROUND_WORKER_LAUNCH_VERSION = 1;
export const BACKGROUND_WORKER_DEFAULT_MAX_ATTEMPTS = 3;
export const BACKGROUND_WORKER_DEFAULT_RETRY_DELAY_MS = 100;
export const BACKGROUND_WORKER_OWNER_WAIT_MS = 5_000;
export const BACKGROUND_WORKER_STARTUP_WAIT_MS = 2_000;
export const BACKGROUND_WORKER_LAUNCH_LEASE_MS = 30_000;
export const BACKGROUND_WORKER_STATE_ERROR = "Invalid background worker state";
export const BACKGROUND_WORKER_LAUNCHER_MUST_RETURN_CHILD_PROCESS_ID_MESSAGE =
  "Background worker launcher must return a child process ID";
export const BACKGROUND_WORKER_LAUNCH_IS_ALREADY_PENDING_MESSAGE =
  "Background worker launch is already pending";
export const BACKGROUND_WORKER_DID_NOT_CLAIM_ITS_LOCK_BEFORE_TIMEOUT_MESSAGE =
  "Background worker did not claim its lock before timeout";
export const BACKGROUND_WORKER_MAX_ATTEMPTS_MUST_BE_POSITIVE_INTEGER_MESSAGE =
  "Background worker max attempts must be a positive integer";
export const BACKGROUND_WORKER_RETRY_DELAY_MUST_BE_NON_NEGATIVE_MESSAGE =
  "Background worker retry delay must be non-negative";
export const BACKGROUND_WORKER_STARTUP_WAIT_MUST_BE_POSITIVE_INTEGER_MESSAGE =
  "Background worker startup wait must be a positive integer";
export const BACKGROUND_WORKER_ACTIVE_MARKER_ALREADY_EXISTS_MESSAGE =
  "Background worker active marker already exists";
export const BACKGROUND_WORKER_RETRY_ATTEMPT_ALREADY_EXISTS_MESSAGE =
  "Background worker retry attempt already exists";
export const BACKGROUND_WORKER_UNSAFE_LOCK_DIRECTORY_MESSAGE =
  "Unsafe background worker lock directory";
export const BACKGROUND_WORKER_UNSAFE_PENDING_MARKER_MESSAGE =
  "Unsafe background worker pending marker";
export const BACKGROUND_WORKER_UNSAFE_ACTIVE_MARKER_MESSAGE =
  "Unsafe background worker active marker";
export const BACKGROUND_WORKER_INVALID_ACTIVE_PATH_MESSAGE =
  "Invalid background worker active path";
export const BACKGROUND_WORKER_MULTIPLE_ACTIVE_MARKERS_MESSAGE =
  "Multiple background worker active markers";
export const BACKGROUND_WORKER_ACTIVE_MARKER_PATH_MISMATCH_MESSAGE =
  "Background worker active marker path mismatch";
export const BACKGROUND_WORKER_UNSAFE_RETRY_ATTEMPT_MESSAGE =
  "Unsafe background worker retry attempt";
export const BACKGROUND_WORKER_INVALID_ATTEMPT_PATH_MESSAGE =
  "Invalid background worker attempt path";
export const BACKGROUND_WORKER_UNSAFE_STAGING_FILE_MESSAGE =
  "Unsafe background worker staging file";
export const BACKGROUND_WORKER_UNSAFE_LAUNCH_MARKER_MESSAGE =
  "Unsafe background worker launch marker";
export const BACKGROUND_WORKER_UNEXPECTED_STATE_PATH_MESSAGE =
  "Unexpected background worker state path";
export const BACKGROUND_WORKER_RETRY_SEQUENCE_HAS_GAP_MESSAGE =
  "Background worker retry sequence has a gap";
export const BACKGROUND_WORKER_INVALID_LAUNCH_MARKER_MESSAGE =
  "Invalid background worker launch marker";
export const BACKGROUND_WORKER_STATE_DISAPPEARED_MESSAGE = "Background worker state disappeared";
export const BACKGROUND_WORKER_INVALID_MARKER_MESSAGE = "Invalid background worker marker";
export const BACKGROUND_WORKER_INVALID_RETRY_ATTEMPT_MESSAGE =
  "Invalid background worker retry attempt";
