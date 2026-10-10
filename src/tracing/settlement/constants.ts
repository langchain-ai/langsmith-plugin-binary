const TURN_REPOSITORY_KEYS = [
  "repository_name",
  "repository_provider",
  "repository_url",
  "git_branch",
  "git_commit_sha",
] as const;

const REPOSITORY_METADATA_KEYS = [...TURN_REPOSITORY_KEYS, "ls_attribution_identifier"] as const;

const REPOSITORY_NAME_KEY = "repository_name";

const ATTRIBUTION_IDENTIFIER_KEY = "ls_attribution_identifier";
const SETTLEMENT_EVENT_ID_PREFIX = "turn-settlement-";

export {
  ATTRIBUTION_IDENTIFIER_KEY,
  REPOSITORY_METADATA_KEYS,
  REPOSITORY_NAME_KEY,
  SETTLEMENT_EVENT_ID_PREFIX,
};
