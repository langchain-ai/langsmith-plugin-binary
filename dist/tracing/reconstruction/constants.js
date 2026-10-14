export const RECONSTRUCTION_DRAIN_LOCK = "reconstruction";
export const RECONSTRUCTION_RUN_ID_PREFIX = "reconstruction:";
export const RECONSTRUCTION_MAPPING_EVENT_ID_PREFIX = "reconstruction-map:";
export const RECONSTRUCTION_JOB_KIND = "reconstruction-job-v1";
export const RECONSTRUCTION_MAPPING_KIND = "reconstruction-map-v1";
export const RECONSTRUCTION_RECORD_VERSION = 1;
export const RECONSTRUCTION_DEFERRED_REASON = "missing-thread-identity";
export const RECONSTRUCTION_CLOSURE_STATES = ["open", "provisional", "authoritative"];
export const RECONSTRUCTION_JOB_INPUT_KEYS = [
    "eventId",
    "privacyMode",
    "sourceRefs",
    "turnEvidence",
    "turnId",
];
export const RECONSTRUCTION_JOB_OPTIONAL_INPUT_KEYS = [
    "sourceAgeStartedAtMs",
    "sourceSnapshots",
];
export const RECONSTRUCTION_SOURCE_SNAPSHOT_KEYS = [
    "sourceAgeStartedAtMs",
    "sourceRef",
    "submission",
];
export const RECONSTRUCTION_SOURCE_SNAPSHOT_OPTIONAL_KEYS = ["attributionContext"];
export const RECONSTRUCTION_STORED_JOB_KEYS = [
    "privacyMode",
    "recordVersion",
    "sourceRefs",
];
export const RECONSTRUCTION_STORED_JOB_OPTIONAL_KEYS = [
    "sourceAgeStartedAtMs",
    "sourceSnapshots",
];
export const RECONSTRUCTION_ATTRIBUTION_CONTEXT_KEYS = ["toolOrigin"];
export const RECONSTRUCTION_ATTRIBUTION_CONTEXT_OPTIONAL_KEYS = ["pinnedRepositoryKeys"];
export const RECONSTRUCTION_TOOL_ORIGIN_KEYS = ["namedAPath"];
export const RECONSTRUCTION_TOOL_ORIGIN_OPTIONAL_KEYS = ["cwd", "path"];
export const RECONSTRUCTION_OUTPUT_KEYS = ["eventId", "submission"];
export const RECONSTRUCTION_OUTPUT_OPTIONAL_KEYS = [
    "dependencies",
    "sourceRef",
    "turnEvidence",
];
export const RECONSTRUCTION_TURN_EVIDENCE_KEYS = ["childRunIds", "closureState"];
export const RECONSTRUCTION_TURN_EVIDENCE_KEYS_WITH_ROOT = [
    "childRunIds",
    "closureState",
    "rootRunId",
];
export const RECONSTRUCTION_DEPENDENCY_KEYS = [
    "eventId",
    "integration",
    "sessionId",
    "turnId",
];
export const RECONSTRUCTION_OUTPUTS_MUST_BE_ARRAY_MESSAGE = "Reconstruction outputs must be an array";
export const RECONSTRUCTION_OUTPUT_HAS_UNSUPPORTED_FIELDS_MESSAGE = "Reconstruction output has unsupported fields";
export const RECONSTRUCTION_EVENT_IDS_MUST_BE_UNIQUE_MESSAGE = "Reconstruction event IDs must be unique";
export const RECONSTRUCTION_INTEGRATION_CHANGED_MESSAGE = "Reconstruction integration changed";
export const RECONSTRUCTION_PRIVACY_MODE_IS_INVALID_MESSAGE = "Reconstruction privacy mode is invalid";
export const RECONSTRUCTION_METADATA_FULL_MODE_MESSAGE = "Metadata reconstruction cannot emit full-mode captures";
export const RECONSTRUCTION_DEPENDENCIES_MUST_BE_ARRAY_MESSAGE = "Reconstruction dependencies must be an array";
export const RECONSTRUCTION_EVIDENCE_IDENTITY_MESSAGE = "Reconstructed turn evidence must preserve known run identities";
export const RECONSTRUCTION_SNAPSHOT_OUTPUTS_REQUIRE_SOURCE_REF_MESSAGE = "Snapshot outputs require a source ref";
export const RECONSTRUCTION_OUTPUT_SOURCE_REF_HAS_NO_SNAPSHOT_MESSAGE = "Output source ref has no snapshot";
export const RECONSTRUCTION_OUTPUT_REF_UNKNOWN_MESSAGE = "Output source ref is not in the reconstruction job";
export const RECONSTRUCTION_DEPENDENCY_SCOPE_MESSAGE = "Reconstruction dependencies must contain only capture scopes";
export const RECONSTRUCTION_DEPENDENCY_INTEGRATION_MESSAGE = "Reconstruction dependencies must use the same integration";
export const RECONSTRUCTION_CAPTURES_CANNOT_DEPEND_ON_THEMSELVES_MESSAGE = "Reconstruction captures cannot depend on themselves";
export const RECONSTRUCTION_DEPENDENCIES_MUST_BE_UNIQUE_MESSAGE = "Reconstruction dependencies must be unique";
export const RECONSTRUCTION_JOB_HAS_UNSUPPORTED_FIELDS_MESSAGE = "Reconstruction job has unsupported fields";
export const RECONSTRUCTION_SOURCE_REFS_ARE_REQUIRED_MESSAGE = "Reconstruction source refs are required";
export const RECONSTRUCTION_SOURCE_REFS_MUST_BE_UNIQUE_MESSAGE = "Reconstruction source refs must be unique";
export const RECONSTRUCTION_SOURCE_CONFLICT_MESSAGE = "Reconstruction jobs cannot combine snapshots with a job-level source age";
export const RECONSTRUCTION_SNAPSHOTS_EMPTY_MESSAGE = "Reconstruction source snapshots must be a nonempty array";
export const RECONSTRUCTION_SNAPSHOT_FIELDS_MESSAGE = "Reconstruction source snapshot has unsupported fields";
export const RECONSTRUCTION_SNAPSHOT_REF_MUST_BELONG_TO_JOB_MESSAGE = "Reconstruction snapshot ref must belong to the job";
export const RECONSTRUCTION_SNAPSHOT_REFS_MUST_BE_UNIQUE_MESSAGE = "Reconstruction snapshot refs must be unique";
export const RECONSTRUCTION_SNAPSHOT_PRIVACY_MESSAGE = "Snapshot privacy mode must match the reconstruction job";
export const RECONSTRUCTION_SNAPSHOT_START_TIME_MESSAGE = "Source snapshot posts must preserve their start time";
export const RECONSTRUCTION_SNAPSHOT_NOT_READY_MESSAGE = "Reconstruction snapshots must be ready for shared projection";
export const RECONSTRUCTION_SNAPSHOT_COVERAGE_MESSAGE = "Source snapshots must cover every reconstruction source ref";
export const RECONSTRUCTION_PATHLESS_REF_MESSAGE = "Snapshot source refs must be pathless identifiers";
export const RECONSTRUCTION_CONTEXT_FIELDS_MESSAGE = "Attribution context has unsupported fields";
export const RECONSTRUCTION_TOOL_ORIGIN_HAS_UNSUPPORTED_FIELDS_MESSAGE = "Tool origin has unsupported fields";
export const RECONSTRUCTION_PINNED_BLANK_MESSAGE = "Pinned repository keys must be nonblank";
export const RECONSTRUCTION_PINNED_UNIQUE_MESSAGE = "Pinned repository keys must be unique";
export const RECONSTRUCTION_EVIDENCE_STRUCTURAL_MESSAGE = "Reconstruction turn evidence must be structural only";
export const RECONSTRUCTION_CLOSURE_STATE_MESSAGE = "Reconstruction turn evidence has an invalid closure state";
export const RECONSTRUCTION_STORED_NAMESPACE_MESSAGE = "Stored reconstruction job namespace does not match";
export const RECONSTRUCTION_UNSUPPORTED_RECONSTRUCTION_JOB_MESSAGE = "Unsupported reconstruction job";
export const RECONSTRUCTION_STORED_FIELDS_MESSAGE = "Stored reconstruction job has unsupported fields";
export const RECONSTRUCTION_STORED_PRIVACY_MESSAGE = "Invalid stored reconstruction privacy mode";
export const RECONSTRUCTION_STORED_REFS_EMPTY_MESSAGE = "Stored reconstruction source refs are empty";
export const RECONSTRUCTION_STORED_REFS_UNIQUE_MESSAGE = "Stored reconstruction source refs are not unique";
export const RECONSTRUCTION_STORED_SOURCE_CONFLICT_MESSAGE = "Stored reconstruction job combines snapshots with a job-level source age";
export const RECONSTRUCTION_PROVENANCE_MESSAGE = "Reconstruction jobs cannot store metadata provenance";
export const RECONSTRUCTION_JOB_DEPENDENCIES_MESSAGE = "Reconstruction jobs cannot have capture dependencies";
export const RECONSTRUCTION_UNSUPPORTED_RECONSTRUCTION_MAPPING_MESSAGE = "Unsupported reconstruction mapping";
export const RECONSTRUCTION_STORED_NO_OUTPUTS_MESSAGE = "Stored reconstruction mapping has no outputs";
export const RECONSTRUCTION_STORED_EVENTS_UNIQUE_MESSAGE = "Stored reconstruction event IDs are not unique";
export const RECONSTRUCTION_STORED_DEPENDENCIES_MESSAGE = "Stored reconstruction dependencies are invalid";
export const RECONSTRUCTION_DEFERRAL_REASON_INVALID_MESSAGE = "Invalid reconstruction deferral reason";
export const RECONSTRUCTION_RESULT_STATUS_INVALID_MESSAGE = "Invalid reconstruction result status";
export const RECONSTRUCTION_NO_CAPTURES_MESSAGE = "Reconstruction produced no captures";
export const RECONSTRUCTION_TERMINAL_OUTCOME_MESSAGE = "Could not record terminal reconstruction outcome:";
export const RECONSTRUCTION_CALLBACKS_REQUIRED_MESSAGE = "Reconstruction callbacks are required";
export const RECONSTRUCTION_DRAIN_TIME_MESSAGE = "Drain time must be finite";
export const RECONSTRUCTION_RECORD_UNSUPPORTED_MESSAGE = "Unsupported reconstruction record";
export const RECONSTRUCTION_JOB_MISSING_MESSAGE = "Reconstruction job disappeared";
export const RECONSTRUCTION_LABEL_OUTPUT = "Reconstruction output";
export const RECONSTRUCTION_LABEL_EVENT_ID = "Event ID";
export const RECONSTRUCTION_LABEL_EVENT_ID_FIELD = "event ID";
export const RECONSTRUCTION_LABEL_SUBMISSION = "Reconstruction submission";
export const RECONSTRUCTION_LABEL_INTEGRATION = "Integration";
export const RECONSTRUCTION_LABEL_RUN = "Run";
export const RECONSTRUCTION_LABEL_RUN_ID = "Run ID";
export const RECONSTRUCTION_LABEL_RUN_ID_FIELD = "run ID";
export const RECONSTRUCTION_LABEL_SOURCE_REF = "Source ref";
export const RECONSTRUCTION_LABEL_SOURCE_REF_FIELD = "source ref";
export const RECONSTRUCTION_SUBMISSION_INVALID_MESSAGE = "Reconstruction submission is invalid";
//# sourceMappingURL=constants.js.map