const TURN_REPOSITORY_KEYS = [
    "repository_name",
    "repository_provider",
    "repository_url",
    "git_branch",
    "git_commit_sha",
];
const REPOSITORY_METADATA_KEYS = [...TURN_REPOSITORY_KEYS, "ls_attribution_identifier"];
const REPOSITORY_NAME_KEY = "repository_name";
const ATTRIBUTION_IDENTIFIER_KEY = "ls_attribution_identifier";
export const SETTLEMENT_EVENT_ID_PREFIX = "turn-settlement-";
export { ATTRIBUTION_IDENTIFIER_KEY, REPOSITORY_METADATA_KEYS, REPOSITORY_NAME_KEY };
export const SETTLEMENT_DROPPED_RUN_WARNING = "Trace work for run {runId} was dropped, so it is left out; the rest of its turn is still being finished.";
export const SETTLEMENT_ATTRIBUTION_LOST_MESSAGE = "Settlement metadata could not preserve attribution";
export const SETTLEMENT_QUIET_TURN_MS = 2 * 60 * 60 * 1000;
export const SETTLEMENT_NEVER_ENDED_WARNING = "Turn {turnId} never ended, so it was finished with the work saved for it; its root run may stay open.";
//# sourceMappingURL=constants.js.map