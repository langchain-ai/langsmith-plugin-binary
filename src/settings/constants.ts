import { constants } from "node:fs";

export const COMMON_BOOLEAN_SETTINGS = {
  enabled: { default: false, restrictive: false },
  defaultMuted: { default: false, restrictive: true },
} as const;

export const COMMON_NOTICE_COOLDOWN_OFF = "off";
export const COMMON_STRICT_BOOLEAN_FIELDS = ["redact", "strict_auth"] as const;

export const COMMON_DEFAULT_API_URL = "https://api.smith.langchain.com";
export const COMMON_USER_ONLY_FIELDS = ["profile"] as const;

export const COMMON_CONFIG_FILE_NAME = "langsmith.json";
export const COMMON_CONFIG_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
export const COMMON_CONFIG_ROOT_FILE_NAME = "langsmith-plugins.json";
export const COMMON_CONFIG_USER_ROOT_FILE_NAME = ".langsmith-plugins.json";

export const MANAGED_CONFIG_DIRECTORY = ".langsmith-plugins";

export const MANAGED_CONFIG_FILE_NAME = "managed.json";

export const MANAGED_CONFIG_OPEN_FLAGS = COMMON_CONFIG_OPEN_FLAGS | (constants.O_NOFOLLOW ?? 0);

export const MANAGED_CONFIG_OWNER_UID = 0;

export const GROUP_OR_OTHERS_WRITE_BITS = 0o022;

export const MANAGED_CONFIG_OVERRIDE_SOURCES = [
  "env",
  "harness",
  "root",
  "user",
  "userRoot",
] as const;

export const MANAGED_CONFIG_UNSAFE_OWNERSHIP =
  "LangSmith managed settings aren't owned by root, so tracing is off. Contact your admin.";

export const MANAGED_CONFIG_INVALID =
  "LangSmith managed settings are invalid, so tracing is off. Contact your admin.";

export const MANAGED_CONFIG_UNLOCKABLE_WARNING =
  "The managed config sets {fields}, which this plugin can't lock, so it is ignored.";
export const MANAGED_CONFIG_OVERRIDE_WARNING =
  "Ignored settings the managed config locks: {overrides}.";
export const MANAGED_CONFIG_OVERRIDE_FIELD_SEPARATOR = "; ";
export const MANAGED_CONFIG_OVERRIDE_SOURCE_SEPARATOR = ", ";

export const ACCOUNT_LOOKUP_TIMEOUT_MS = 2_000;
export const MACOS_ACCOUNT_LOOKUP = "/usr/bin/id";
export const MACOS_ACCOUNT_LOOKUP_ARGUMENTS = ["-P"];
export const MACOS_ACCOUNT_HOME_FIELD = 8;
export const LINUX_ACCOUNT_LIST_FILE = "/etc/passwd";
export const LINUX_ACCOUNT_LOOKUPS = ["/usr/bin/getent", "/bin/getent"];
export const LINUX_ACCOUNT_HOME_FIELD = 5;
export const ACCOUNT_ID_FIELD = 2;
export const ACCOUNT_FIELD_SEPARATOR = ":";

export const UTF8_BOM = /^\uFEFF/;

export const SETUP_URL_PATTERN = /^https?:\/\//iu;
export const SETUP_API_KEY_PATTERN = /(?:^|[^a-z0-9])(?:lsv2_|ls__)/iu;
export const SETUP_API_KEY_GIVEN =
  "That looks like a LangSmith API key, so nothing was changed. Put the key in your config file instead, since anything typed in chat can end up in your history and traces.";
export const SETUP_LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/u;
export const SETUP_MULTIPLE_LINES =
  "Setup takes its project and URL on one line, so nothing was changed. Send anything else as its own message.";
export const SETUP_ARGUMENT_SEPARATOR = /\s+/u;
export const SETUP_FILE_MODE = 0o600;
export const SETUP_DIRECTORY_MODE = 0o700;
export const SETUP_TEMP_SUFFIX = ".tmp";
export const SETUP_PROJECT_QUOTES = /^(["'])(.*)\1$/u;
export const SETUP_INVALID_URL = "{url} isn't a valid URL, so nothing was changed.";
export const SETUP_TOO_MANY_URLS = "Setup takes one URL, so nothing was changed.";
export const SETUP_URL_WITH_CREDENTIALS =
  "Leave the username and password out of the URL and put the API key in your config file instead, so nothing was changed.";
export const SETUP_URL_WITH_QUERY =
  "Leave the ? and # parts out of the URL, since uploads can't use them, so nothing was changed.";
export const SETUP_INVALID_CONFIG =
  "{path} has a setting LangSmith can't use, so nothing was changed. Fix that setting and run setup again.";
export const SETUP_UNREADABLE_CONFIG =
  "Couldn't read {path} as a JSON object, so nothing was changed. Fix or remove that file and run setup again.";
export const SETUP_ENABLED = "Turned LangSmith tracing on in {path}.";
export const SETUP_DESTINATION = "Traces go to the {project} project at {apiUrl}.";
export const SETUP_REPLICA_DESTINATION = {
  one: "Traces go to the replica destination in your settings, which replaces the usual project and URL.",
  many: "Traces go to the {replicaCount} replica destinations in your settings, which replace the usual project and URL.",
} as const;
export const SETUP_AGENT_DESTINATION = "Traces go to the {agentId} agent at {apiUrl}.";
export const SETUP_DESTINATION_FIELDS = /\{(project|agentId|apiUrl)\}/gu;
export const SETUP_FILE_FAILED =
  "Couldn't update {path} ({reason}), so nothing was changed. Check that file's permissions and run setup again.";
export const SETUP_FILE_FAILED_FIELDS = /\{(path|reason)\}/gu;
export const SETUP_STILL_OFF =
  "Tracing is still off because an environment variable, a project's langsmith.json or langsmith-plugins.json, or your admin's managed settings turn it off.";
export const SETUP_OVERRIDDEN =
  "Another setting overrides part of this (an agent_id, an environment variable, a project's langsmith.json or langsmith-plugins.json, or your admin's managed settings), so the values above are what's in effect.";
export const SETUP_MUTED =
  "This thread is muted, so traces keep their structure and usage but not your prompts, responses or tool data.";
export const SETUP_SIGN_IN = {
  login: "Signed in with the LangSmith CLI.",
  "api-key": "Using your LangSmith API key.",
} as const;
export const SETUP_NO_CREDENTIAL =
  "No LangSmith login or API key found yet, so run `langsmith auth login` to sign in.";
