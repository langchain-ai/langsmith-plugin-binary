import { LOGIN_NOTICE_HEADING } from "./constants.js";

export const LOGIN_EXPIRED_STATUS = 401;
export const LOGIN_PAUSED_NOTICE = [
  LOGIN_NOTICE_HEADING,
  "Your LangSmith login expired so this session isn't being traced.",
  "▶ Run the following command: langsmith auth login",
].join("\n");
export const LOGIN_KEY_REJECTED_NOTICE = [
  LOGIN_NOTICE_HEADING,
  "Your LangSmith API key was rejected so this session isn't being traced.",
  "▶ Replace the key, or remove it and run: langsmith auth login",
].join("\n");
export const LOGIN_MARKER_WARNING = "Could not record the expired LangSmith login:";
export const LOGIN_CLEANUP_WARNING = "Could not clear the LangSmith sign-in marker:";
export const LOGIN_STATE_FILE = "sign-in.json";
export const LOGIN_NOTICE_KIND = "login-expired";
export const LOGIN_KEY_REJECTED_ENTRY = "api-key-rejected.";
