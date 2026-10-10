export declare const RECONSTRUCTION_DIRECTORY = "reconstruction-v1";
export declare const RECONSTRUCTION_WORKER_DIRECTORY = "workers";
export declare const RECONSTRUCTION_SESSIONS_DIRECTORY = "sessions";
export declare const RECONSTRUCTION_DRAIN_LOCK = "drain";
export declare const RECONSTRUCTION_RUN_ID_PREFIX = "reconstruction:";
export declare const RECONSTRUCTION_MAPPING_EVENT_ID_PREFIX = "reconstruction-map:";
export declare const RECONSTRUCTION_JOB_KIND = "reconstruction-job-v1";
export declare const RECONSTRUCTION_MAPPING_KIND = "reconstruction-map-v1";
export declare const RECONSTRUCTION_RECORD_VERSION = 1;
export declare const RECONSTRUCTION_DEFERRED_REASON = "missing-thread-identity";
export declare const RECONSTRUCTION_CLOSURE_STATES: readonly ["open", "provisional", "authoritative"];
export declare const RECONSTRUCTION_JOB_INPUT_KEYS: readonly ["eventId", "privacyMode", "sourceRefs", "turnEvidence", "turnId"];
export declare const RECONSTRUCTION_TURN_EVIDENCE_KEYS: readonly ["childRunIds", "closureState"];
export declare const RECONSTRUCTION_TURN_EVIDENCE_KEYS_WITH_ROOT: readonly ["childRunIds", "closureState", "rootRunId"];
export declare const RECONSTRUCTION_DEPENDENCY_KEYS: readonly ["eventId", "integration", "sessionId", "turnId"];
//# sourceMappingURL=constants.d.ts.map