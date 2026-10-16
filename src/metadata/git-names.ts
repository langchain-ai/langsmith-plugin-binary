import { GIT_METADATA_KEYS, LEGACY_GIT_METADATA_KEYS } from "./constants.js";
import type { GitMetadataRole } from "./models.js";

export function withBothGitMetadataNames<T extends Record<string, unknown>>(metadata: T): T {
  const both: Record<string, unknown> = { ...metadata };
  for (const role of Object.keys(GIT_METADATA_KEYS) as GitMetadataRole[]) {
    const value = both[GIT_METADATA_KEYS[role]] ?? both[LEGACY_GIT_METADATA_KEYS[role]];
    if (value === undefined) continue;
    both[GIT_METADATA_KEYS[role]] ??= value;
    both[LEGACY_GIT_METADATA_KEYS[role]] ??= value;
  }
  return both as T;
}
