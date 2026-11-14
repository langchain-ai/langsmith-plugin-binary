export const LOCK_TEMPORARY_SUFFIX = ".claim.";
export const LOCK_TAKEOVER_SUFFIX = ".takeover";
export const LOCK_ATTEMPTS = 3;
export const LOCK_TAKEOVER_STALE_MS = 1_000;

export const UNREAD_NOTES = { base: 0, offset: 0 };
export const HOOK_WARNING_PREFIX = "langsmith tracer: ";

export const READ_DEBOUNCE_MS = 20;
export const TICK_MS = 500;
export const IDLE_EXIT_MS = 3_000;
export const ABANDONED_EXIT_MS = 600_000;

export const SESSION_END_EVENT = "SessionEnd";
export const WORKER_STARTED_LOG = "worker started";
export const WORKER_STOPPED_LOG = "worker stopped";
export const WORKER_RESUMED_LOG = "worker resumed for late notes";
