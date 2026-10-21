export const LOGIN_STATE_SUBFOLDER = "sign-in";
export const LOGIN_SIGN_IN_LIFETIME = "15m";
export const LOGIN_SIGN_IN_LIFETIME_MS = 15 * 60 * 1000;
export const LOGIN_CLI_NAME = "langsmith";
export const LOGIN_CLI_ARGUMENTS = ["auth", "login"] as const;
export const LOGIN_CLI_API_URL_FLAG = "--api-url";
export const LOGIN_CLI_PROFILE_FLAG = "--profile";
export const LOGIN_CLI_TIMEOUT_FLAG = "--timeout";
export const LOGIN_NOTIFICATION_TITLE = "LangSmith tracing";
export const LOGIN_CLI_HOME_FOLDERS = [".local/bin", "go/bin"] as const;
export const LOGIN_CLI_WINDOWS_FOLDER = "Programs/langsmith/bin";
export const LOGIN_CLI_WINDOWS_ROOT_VARIABLE = "LOCALAPPDATA";
export const LOGIN_CLI_SYSTEM_FOLDERS = ["/usr/local/bin", "/opt/homebrew/bin"] as const;
export const LOGIN_CLI_WAITING_PATTERN = /Waiting for authorization\.\.\.\s*$/u;
export const LOGIN_CLI_CODE_PATTERN = /(?:Enter code|or enter it): (\S+)/u;
export const LOGIN_CODE_WAIT_MS = 10_000;
export const LOGIN_CODE_POLL_MS = 200;
export const LOGIN_EXPIRED_STATUS = 401;
export const LOGIN_PAUSED_NOTICE =
  "LangSmith token expired. Run `langsmith auth login` to resume tracing.";
export const LOGIN_BROWSER_CODE_NOTICE =
  "LangSmith token expired. Enter code {code} on the browser page or run `langsmith auth login`.";
export const LOGIN_BROWSER_NOTICE =
  "LangSmith token expired. Sign in on the browser page or run `langsmith auth login`.";
export const LOGIN_CLI_MISSING_NOTICE =
  "LangSmith token expired. Install the CLI with `curl -fsSL https://cli.langsmith.com/install.sh | sh`, then run `langsmith auth login`.";
export const LOGIN_CLI_MISSING_WINDOWS_NOTICE =
  "LangSmith token expired. Install the CLI with `irm https://cli.langsmith.com/install.ps1 | iex`, then run `langsmith auth login`.";
export const LOGIN_RENEWAL_WARNING = "Could not start the LangSmith sign-in:";
export const LOGIN_MARKER_WARNING = "Could not record the expired LangSmith login:";
export const LOGIN_STATE_FILE = "sign-in.json";
export const LOGIN_CODE_FILE_FLAG = "w";
export const LOGIN_CODE_FILE_MODE = 0o600;
export const LOGIN_NOTICE_KIND = "login-expired";
export const LOGIN_KEY_REJECTED_ENTRY = "api-key-rejected";
export const LOGIN_KEY_REJECTED_NOTICE =
  "LangSmith API key was rejected. Create a new key, or remove it and run `langsmith auth login`.";
