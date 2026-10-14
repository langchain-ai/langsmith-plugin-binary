declare const REPOSITORY_METADATA_KEYS: readonly ["repository_name", "repository_provider", "repository_url", "git_branch", "git_commit_sha", "ls_attribution_identifier"];
declare const REPOSITORY_NAME_KEY = "repository_name";
declare const ATTRIBUTION_IDENTIFIER_KEY = "ls_attribution_identifier";
export declare const SETTLEMENT_EVENT_ID_PREFIX = "turn-settlement-";
export { ATTRIBUTION_IDENTIFIER_KEY, REPOSITORY_METADATA_KEYS, REPOSITORY_NAME_KEY };
export declare const SETTLEMENT_DROPPED_RUN_WARNING = "Trace work for run {runId} was dropped, so it is left out; the rest of its turn is still being finished.";
export declare const SETTLEMENT_ATTRIBUTION_LOST_MESSAGE = "Settlement metadata could not preserve attribution";
export declare const SETTLEMENT_QUIET_TURN_MS: number;
export declare const SETTLEMENT_NEVER_ENDED_WARNING = "Turn {turnId} never ended, so it was finished with the work saved for it; its root run may stay open.";
//# sourceMappingURL=constants.d.ts.map