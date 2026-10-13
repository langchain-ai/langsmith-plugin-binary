export const GIT_LOCATION_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
];
export const NOT_A_REPOSITORY = /not a git repository \(or any of the parent directories\)/i;
export const REMOTE_PATH_EDGE_SLASHES = /^\/+|\/+$/g;
export const REMOTE_PATH_TRAILING_SLASHES = /\/+$/;
export const REMOTE_GIT_SUFFIX = /\.git$/;
export const REMOTE_LINE_WHITESPACE = /\s+/;
export const SCP_REMOTE_PATTERN = /^(?:[^@]+@)?([^:]+):\/?(.+)$/;
export const GIT_DIRECTORY_NAME = ".git";
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
export const PROVIDER_HOSTS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  devAzure: "dev.azure.com",
};
export const GIT_COMMAND_TIMEOUT_MS = 5_000;
export const GH_LOGIN_COMMAND = "gh";
export const GH_LOGIN_ARGUMENTS = ["api", "user", "--jq", ".login"];
export const GH_LOGIN_TIMEOUT_MS = 5_000;
export const GH_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
export const GH_LOGIN_NULL_OUTPUT = "null";
export const GH_LOGIN_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
