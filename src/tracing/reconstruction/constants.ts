import { CAPTURE_RECONSTRUCTION_JOB_KIND } from "../../storage/capture/constants.js";

export const RECONSTRUCTION_DIRECTORY = "reconstruction-v1";
export const RECONSTRUCTION_WORKER_DIRECTORY = "workers";
export const RECONSTRUCTION_SESSIONS_DIRECTORY = "sessions";
export const RECONSTRUCTION_DRAIN_LOCK = "drain";
export const RECONSTRUCTION_RUN_ID_PREFIX = "reconstruction:";
export const RECONSTRUCTION_MAPPING_EVENT_ID_PREFIX = "reconstruction-map:";
export const RECONSTRUCTION_JOB_KIND = CAPTURE_RECONSTRUCTION_JOB_KIND;
export const RECONSTRUCTION_MAPPING_KIND = "reconstruction-map-v1";
export const RECONSTRUCTION_RECORD_VERSION = 1;
export const RECONSTRUCTION_DEFERRED_REASON = "missing-thread-identity";
export const RECONSTRUCTION_CLOSURE_STATES = ["open", "provisional", "authoritative"] as const;
export const RECONSTRUCTION_JOB_INPUT_KEYS = [
  "eventId",
  "privacyMode",
  "sourceRefs",
  "turnEvidence",
  "turnId",
] as const;
export const RECONSTRUCTION_JOB_OPTIONAL_INPUT_KEYS = [
  "sourceAgeStartedAtMs",
  "sourceSnapshots",
] as const;
export const RECONSTRUCTION_SOURCE_SNAPSHOT_KEYS = [
  "sourceAgeStartedAtMs",
  "sourceRef",
  "submission",
] as const;
export const RECONSTRUCTION_SOURCE_SNAPSHOT_OPTIONAL_KEYS = ["attributionContext"] as const;
export const RECONSTRUCTION_STORED_JOB_KEYS = [
  "privacyMode",
  "recordVersion",
  "sourceRefs",
] as const;
export const RECONSTRUCTION_STORED_JOB_OPTIONAL_KEYS = [
  "sourceAgeStartedAtMs",
  "sourceSnapshots",
] as const;
export const RECONSTRUCTION_ATTRIBUTION_CONTEXT_KEYS = ["toolOrigin"] as const;
export const RECONSTRUCTION_ATTRIBUTION_CONTEXT_OPTIONAL_KEYS = ["pinnedRepositoryKeys"] as const;
export const RECONSTRUCTION_TOOL_ORIGIN_KEYS = ["namedAPath"] as const;
export const RECONSTRUCTION_TOOL_ORIGIN_OPTIONAL_KEYS = ["cwd", "path"] as const;
export const RECONSTRUCTION_OUTPUT_KEYS = ["eventId", "submission"] as const;
export const RECONSTRUCTION_OUTPUT_OPTIONAL_KEYS = [
  "dependencies",
  "sourceRef",
  "turnEvidence",
] as const;
export const RECONSTRUCTION_TURN_EVIDENCE_KEYS = ["childRunIds", "closureState"] as const;
export const RECONSTRUCTION_TURN_EVIDENCE_KEYS_WITH_ROOT = [
  "childRunIds",
  "closureState",
  "rootRunId",
] as const;
export const RECONSTRUCTION_DEPENDENCY_KEYS = [
  "eventId",
  "integration",
  "sessionId",
  "turnId",
] as const;
