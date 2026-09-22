export const HEREDOC_TERMINATOR = "HELP";
export const MULTI_LINE_OR_CONTROL = /\p{Cc}/u;
export const EXECUTABLE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const REPOSITORY_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const ENVIRONMENT_PREFIX = /^[A-Z][A-Z0-9_]*$/;

export const TEMPLATE_URL = new URL("../installer/install.sh.template", import.meta.url);

export const ENVIRONMENT_VARIABLE_DESCRIPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["RELEASES_API", "GitHub releases API to install from"],
  ["DOWNLOAD_BASE", "Release download base URL"],
];

export const DEFAULT_PUBLISHED_TARGETS: Readonly<Record<string, readonly string[]>> = {
  darwin: ["arm64", "x64"],
};
