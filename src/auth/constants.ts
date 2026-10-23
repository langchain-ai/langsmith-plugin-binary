export const LOGIN_CONFIG_FILE_VARIABLE = "LANGSMITH_CONFIG_FILE";
export const LOGIN_PROFILE_VARIABLE = "LANGSMITH_PROFILE";
export const LOGIN_HOME_VARIABLES = ["HOME", "USERPROFILE"] as const;
export const LOGIN_API_KEY_VARIABLES = ["LANGSMITH_API_KEY", "LANGCHAIN_API_KEY"] as const;
export const LOGIN_CONFIG_DIRECTORY = ".langsmith";
export const LOGIN_CONFIG_FILE_NAME = "config.json";
export const LOGIN_DEFAULT_PROFILE = "default";
export const LOGIN_CONFIG_KEYS = {
  profiles: "profiles",
  currentProfile: "current_profile",
  oauth: "oauth",
  refreshToken: "refresh_token",
  accessToken: "access_token",
  apiKey: "api_key",
  workspaceId: "workspace_id",
  apiUrl: "api_url",
} as const;
export const LOGIN_DEFAULT_API_URL = "https://api.smith.langchain.com";
export const LOGIN_URL_TRAILING_PATTERN = /(\/api\/v1)?\/*$/u;
export const LOGIN_TOKEN_HASH = "sha256";
export const LOGIN_TOKEN_HASH_LENGTH = 16;
export const LOGIN_EXPIRED_MARKER_PREFIX = "login-expired-";
export const LOGIN_CONFIG_FILE_ENCODING = "utf8";

export const LOGIN_NOTICE_RULE = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
export const LOGIN_NOTICE_HEADING = "⚠️  LANGSMITH TRACING IS PAUSED";
export const LOGIN_NONE_REASON = [
  LOGIN_NOTICE_RULE,
  LOGIN_NOTICE_HEADING,
  "You're not signed in to LangSmith so this session isn't being traced.",
  "▶ Run the following command: langsmith auth login",
  LOGIN_NOTICE_RULE,
].join("\n");
export const LOGIN_ENV_KEY_REASON =
  "{variable} is overriding your LangSmith login. Unset it or use it as the plugin's API key.";
export const LOGIN_ENDPOINT_MISMATCH_REASON = [
  LOGIN_NOTICE_RULE,
  LOGIN_NOTICE_HEADING,
  "Your LangSmith login is for {loginUrl} but tracing sends to {apiUrl} so this session isn't being traced.",
  "▶ Point tracing at {loginUrl}, or set an API key for {apiUrl}",
  LOGIN_NOTICE_RULE,
].join("\n");
export const LOGIN_REPLICA_REFUSED_REASON =
  "LangSmith replicas on {urls} need their own API key, so they're skipped.";
