import { CAPTURE_DIRECTORY, CAPTURE_RECORD_LOCK_DIRECTORY, } from "../../storage/capture/constants.js";
import { BACKGROUND_WORKER_DIRECTORY } from "../background-worker/constants.js";
import { DELIVERY_DIRECTORY } from "../delivery/constants.js";
import { RECONSTRUCTION_DIRECTORY } from "../reconstruction/constants.js";
export const ROOT_RUN_EXECUTION_ORDER = 1;
export const DOTTED_ORDER_TIME_PREFIX_LENGTH = 18;
export const DOTTED_ORDER_SEGMENT_PATTERN = /^(\d{8}T\d{12}Z)([^.]+)$/u;
export const DOTTED_ORDER_STRIP_PATTERN = /[-:.]/gu;
export const LIFECYCLE_POST_EVENT_KIND = "run-post";
export const LIFECYCLE_PATCH_EVENT_KIND = "run-patch";
export const LIFECYCLE_SETTLEMENT_EVENT_KIND = "run-settlement-patch";
export const LIFECYCLE_ATTRIBUTION_READY_FIELD = "attributionReady";
export const LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY = "lifecycle-settlement-v1";
export const LIFECYCLE_ENGINE_FOLDERS = [
    CAPTURE_DIRECTORY,
    CAPTURE_RECORD_LOCK_DIRECTORY,
    DELIVERY_DIRECTORY,
    BACKGROUND_WORKER_DIRECTORY,
    RECONSTRUCTION_DIRECTORY,
    LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY,
];
export const LIFECYCLE_SETTLEMENT_LOCK_FILE = "drain";
export const LIFECYCLE_SETTLEMENT_LOCK_INTEGRATIONS_DIRECTORY = "integrations";
export const LIFECYCLE_SETTLEMENT_LOCK_SESSIONS_DIRECTORY = "sessions";
export const LIFECYCLE_SETTLEMENT_LOCK_ACCOUNTS_DIRECTORY = "accounts";
export const LIFECYCLE_TURN_CLOSURE_STATES = ["open", "provisional", "authoritative"];
export const LIFECYCLE_SWEEP_WARNING = "Could not clean up old trace files:";
export const LIFECYCLE_CHILD_TURN_GRACE_MS = 60 * 60 * 1000;
export const LIFECYCLE_UPLOAD_ACCOUNT_CHANGED_MESSAGE = "Upload account changed";
export const LIFECYCLE_STORED_RUN_CONTEXT_IS_REQUIRED_MESSAGE = "Stored run context is required";
export const LIFECYCLE_STORED_INTEGRATION_DOES_NOT_MATCH_LIFECYCLE_BRIDGE_MESSAGE = "Stored integration does not match the lifecycle bridge";
export const LIFECYCLE_STORED_RUN_DATA_IS_REQUIRED_MESSAGE = "Stored run data is required";
export const LIFECYCLE_STORED_RUN_ID_DOES_NOT_MATCH_ITS_CAPTURE_MESSAGE = "Stored run ID does not match its capture";
export const LIFECYCLE_STORED_PRIVACY_MODE_IS_INVALID_MESSAGE = "Stored privacy mode is invalid";
export const LIFECYCLE_STORED_CAPTURE_IS_MISSING_THREAD_IDENTITY_MESSAGE = "Stored capture is missing thread identity";
export const LIFECYCLE_RUN_INTEGRATION_MISMATCH_MESSAGE = "Run integration does not match the lifecycle bridge";
export const LIFECYCLE_INVALID_PRIVACY_MODE_MESSAGE = "Invalid privacy mode";
export const LIFECYCLE_INVALID_RUN_OPERATION_MESSAGE = "Invalid run operation";
export const LIFECYCLE_INVALID_CLOSURE_STATE_MESSAGE = "Lifecycle turn evidence has an invalid closure state";
export const LIFECYCLE_RUN_IDENTITY_CHANGED_MESSAGE = "Run identity changed for a persisted capture";
export const LIFECYCLE_PATCH_START_TIME_MESSAGE = "Patch run context must preserve its canonical start time";
export const LIFECYCLE_RUN_TRACE_ORDER_MESSAGE = "Run context must preserve its canonical trace ID and dotted order";
export const LIFECYCLE_INVALID_PATCH_FIELD_MESSAGE = "Invalid patch field";
export const LIFECYCLE_PATCH_FIELDS_UNIQUE_MESSAGE = "Patch fields must be unique";
export const LIFECYCLE_PATCH_FIELD_VALUE_MESSAGE = "Every selected patch field must have a value";
export const LIFECYCLE_INVALID_PATCH_PRIVACY_STATUS_MESSAGE = "Invalid patch privacy status";
export const LIFECYCLE_IDENTITY_FIELD_LABELS = [
    ["parent_run_id", "Parent run ID"],
    ["trace_id", "Trace ID"],
    ["dotted_order", "Dotted order"],
];
//# sourceMappingURL=constants.js.map