import { GIT_METADATA_KEYS, LEGACY_GIT_METADATA_KEYS } from "./constants.js";
export function withBothGitMetadataNames(metadata) {
    const both = { ...metadata };
    for (const role of Object.keys(GIT_METADATA_KEYS)) {
        const value = both[GIT_METADATA_KEYS[role]] ?? both[LEGACY_GIT_METADATA_KEYS[role]];
        if (value === undefined)
            continue;
        both[GIT_METADATA_KEYS[role]] ??= value;
        both[LEGACY_GIT_METADATA_KEYS[role]] ??= value;
    }
    return both;
}
//# sourceMappingURL=git-names.js.map