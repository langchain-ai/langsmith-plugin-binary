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

export const LOGIN_NONE_REASON =
  "LangSmith isn't signed in. Run `langsmith auth login` or set an API key.";
export const LOGIN_ENDPOINT_MISMATCH_REASON =
  "LangSmith login is for {loginUrl} but tracing sends to {apiUrl}. Check your settings or set an API key.";
export const LOGIN_REPLICA_REFUSED_REASON =
  "LangSmith replicas on {urls} need their own API key, so they're skipped.";
