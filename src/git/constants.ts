export const GIT_LOCATION_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
];
export const NOT_A_REPOSITORY = /not a git repository \(or any of the parent directories\)/i;
export const REMOTE_PATH_EDGE_SLASHES = /^\/+|\/+$/g;
export const REMOTE_PATH_TRAILING_SLASHES = /\/+$/;
export const REMOTE_GIT_SUFFIX = /\.git$/;
export const REMOTE_LINE_WHITESPACE = /\s+/;
export const SCP_REMOTE_PATTERN = /^(?:[^@]+@)?([^:]+):\/?(.+)$/;
export const GIT_DIRECTORY_NAME = ".git";
export const GIT_FILE_POINTER = /^gitdir:\s*(.+?)\s*$/m;
export const GIT_MARKERS = {
  REPOSITORY_ROOT: "repository root",
  ONLY_GIT_CAN_SAY: "only git can say",
  NOTHING_HERE: "nothing here",
} as const;
export const GIT_PROVIDERS: Record<string, string> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
  "dev.azure.com": "devAzure",
};
export const SELF_HOSTED_PROVIDER_HINTS = ["github", "gitlab", "bitbucket"];
export const PROVIDER_HOSTS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  devAzure: "dev.azure.com",
};
export const GIT_COMMAND_TIMEOUT_MS = 5_000;
export const GH_LOGIN_COMMAND = "gh";
export const GIT_COMMAND = "git";
export const GIT_COMMAND_MISSING = "is not installed in an absolute PATH folder";
export const GH_LOGIN_ARGUMENTS = ["api", "user", "--jq", ".login"];
export const GH_LOGIN_TIMEOUT_MS = 5_000;
export const GH_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
export const GH_LOGIN_NULL_OUTPUT = "null";
export const GH_LOGIN_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
export const GIT_HEAD_FILE = "HEAD";
export const GIT_COMMON_DIRECTORY_FILE = "commondir";
export const GIT_PACKED_REFS_FILE = "packed-refs";
export const GIT_CONFIG_FILE = "config";
export const BRANCH_REF_PREFIX = "refs/heads/";
export const SYMBOLIC_REF_PATTERN = /^ref: (\S+)/;
export const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const AMBIGUOUS_REF_AFFIXES: readonly (readonly [string, string])[] = [
  ["", ""],
  ["refs/", ""],
  ["refs/tags/", ""],
  ["refs/remotes/", ""],
  ["refs/remotes/", "/HEAD"],
];
export const CONFIG_LINE_BREAK = /\r?\n/;
export const CONFIG_SECTION_PATTERN =
  /^\[([A-Za-z][A-Za-z0-9-]*)(?:\s+"([^"\\]*)")?\]\s*(?:[#;].*)?$/;
export const CONFIG_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/;
export const CONFIG_COMMENT_STARTS = new Set(["#", ";"]);
export const CONFIG_INCLUDE_SECTIONS = new Set(["include", "includeif"]);
export const CONFIG_KEYS = {
  user: { section: "user", key: "name" },
  remoteUrl: { section: "remote", key: "url" },
  insteadOf: { section: "url", key: "insteadof" },
  worktreeConfig: { section: "extensions", key: "worktreeconfig" },
} as const;
export const GIT_CONFIG_LIST_ARGUMENTS = ["config", "--list", "--show-scope", "-z"];
export const LISTED_CONFIG_SEPARATOR = "\0";
export const LISTED_CONFIG_VALUE_SEPARATOR = "\n";
export const CONFIG_SCOPES = { local: "local", worktree: "worktree", command: "command" } as const;
export const REPOSITORY_CONFIG_SCOPES = new Set<string>([
  CONFIG_SCOPES.local,
  CONFIG_SCOPES.worktree,
]);
export const PACKED_REF_SEPARATOR = " ";
export const CONFIG_NAME_SEPARATOR = ".";
export const CONFIG_SECTION_START = "[";
export const CONFIG_ESCAPE = "\\";
export const CONFIG_QUOTE = '"';
export const CONDITIONAL_INCLUDE_SECTION = "includeif";
export const PACKED_REFS_MAX_BYTES = 1_000_000;
export const SNAPSHOT_MAX_REPOSITORIES = 10;
