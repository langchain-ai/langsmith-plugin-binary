export const LOGIN_CONFIG_FILE_VARIABLE = "LANGSMITH_CONFIG_FILE";
export const LOGIN_PROFILE_VARIABLE = "LANGSMITH_PROFILE";
export const LOGIN_WORKSPACE_VARIABLE = "LANGSMITH_WORKSPACE_ID";
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
export const LOGIN_COMMAND = "langsmith auth login";
export const LOGIN_PROFILE_FLAG = "--profile";
export const LOGIN_PLAIN_PROFILE_PATTERN = /^[\w.-]+$/u;
export const LOGIN_WINDOWS_PLATFORM = "win32";
export const LOGIN_QUOTED_PROFILE_APOSTROPHE = "'\\''";

export const LOGIN_NOTICE_HEADING = "⚠️ LANGSMITH TRACING IS PAUSED ⚠️";
export const LOGIN_NONE_REASON = [
  LOGIN_NOTICE_HEADING,
  "You're not signed in to LangSmith so this session isn't being traced.",
  "▶ Run the following command: {command}",
].join("\n");
export const LOGIN_ENDPOINT_MISMATCH_REASON = [
  LOGIN_NOTICE_HEADING,
  "Your LangSmith login is for {loginUrl} but tracing sends to {apiUrl} so this session isn't being traced.",
  "▶ Point tracing at {loginUrl}, or set an API key for {apiUrl}",
].join("\n");
export const AGENT_ID_INVALID_REASON = [
  LOGIN_NOTICE_HEADING,
  "Your agent_id setting {agentId} isn't an agent ID so this session isn't being traced.",
  "▶ Copy the agent ID from LangSmith, which uses lowercase letters, digits and hyphens",
].join("\n");
export const AGENT_ID_PATTERN = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/u;
export const LOGIN_WORKSPACE_INVALID_REASON = [
  LOGIN_NOTICE_HEADING,
  "Your workspace_id setting {workspaceId} isn't a workspace ID so this session isn't being traced.",
  "▶ Copy the workspace ID from LangSmith's workspace settings",
].join("\n");
export const LOGIN_WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const LOGIN_REPLICA_REFUSED_REASON =
  "LangSmith replicas on {urls} need their own API key, so they're skipped.";
