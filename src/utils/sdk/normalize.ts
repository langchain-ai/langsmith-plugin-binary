import { SDK_DOUBLE_QUOTED, SDK_PROFILE_QUOTES, SDK_SINGLE_QUOTED } from "./sdk-constants.js";

export function sdkSetting(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(SDK_DOUBLE_QUOTED, "$1").replace(SDK_SINGLE_QUOTED, "$1");
  return trimmed.trim() === "" ? undefined : trimmed;
}

export function sdkProfileValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().replace(SDK_PROFILE_QUOTES, "") || undefined;
}
