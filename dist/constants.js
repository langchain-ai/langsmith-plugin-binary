export const HEREDOC_TERMINATOR = "HELP";
export const MULTI_LINE_OR_CONTROL = /\p{Cc}/u;
export const EXECUTABLE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const REPOSITORY_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const ENVIRONMENT_PREFIX = /^[A-Z][A-Z0-9_]*$/;
export const TEMPLATE_URL = new URL("../installer/install.sh.template", import.meta.url);
export const ENVIRONMENT_VARIABLE_DESCRIPTIONS = [
    ["RELEASES_API", "GitHub releases API to install from"],
    ["DOWNLOAD_BASE", "Release download base URL"],
];
export const DEFAULT_PUBLISHED_TARGETS = {
    darwin: ["arm64", "x64"],
};
export const RELEASES_PER_PAGE = 100;
export const LIST_TIMEOUT_MS = 15_000;
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
export const CODESIGN_TIMEOUT_MS = 120_000;
export const VERSION_CHECK_TIMEOUT_MS = 30_000;
export const MAX_BINARY_BYTES = 250 * 1024 * 1024;
export const MAX_CHECKSUM_BYTES = 1024;
export const ABANDONED_LOCK_MS = 10 * 60 * 1000;
export const LOCK_FILE_NAME = ".update.lock";
export const DEFAULT_INSTALL_DIRECTORY_NAME = ".langsmith";
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
export const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)(?:\.(\d+))?)?$/;
export const OLDER_THAN_ANY_RELEASE = "0.0.0";
export const MACH_O_ARCHES = { arm64: "arm64", x64: "x86_64" };
export const VERSION_DEFINE = "__LS_INTEGRATION_VERSION__";
export const DEVELOPER_ID_PREFIX = "Developer ID Application:";
export const IDENTITY_LINE = /^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+"([^"]+)"$/gm;
export const TEAM_ID_SUFFIX = /\(([A-Z0-9]{10})\)$/;
export const APPLE_CREDENTIALS = [
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "CSC_KEY_PASSWORD",
    "CSC_LINK",
];
//# sourceMappingURL=constants.js.map