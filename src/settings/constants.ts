export const COMMON_BOOLEAN_SETTINGS = {
  enabled: { default: false, restrictive: false },
  defaultMuted: { default: false, restrictive: true },
} as const;

export const COMMON_CONFIG_FILE_NAME = "langsmith.json";
export const COMMON_CONFIG_ROOT_FILE_NAME = "langsmith-plugins.json";
export const COMMON_CONFIG_USER_ROOT_FILE_NAME = ".langsmith-plugins.json";
