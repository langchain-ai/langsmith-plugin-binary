import { ATTRIBUTION_IDENTIFIER_KEY, REPOSITORY_METADATA_KEYS, REPOSITORY_NAME_KEY, } from "./constants.js";
export function attributionOf(metadata) {
    const carried = {};
    for (const key of REPOSITORY_METADATA_KEYS) {
        const value = metadata?.[key];
        if (typeof value === "string" && value.length > 0)
            carried[key] = value;
    }
    return carried;
}
export const namesARepository = (carried) => carried[REPOSITORY_NAME_KEY] !== undefined;
export function turnAttribution(record) {
    const root = attributionOf(record.root?.metadata);
    const inToolCallOrder = [...record.children]
        .sort((left, right) => (left.dotted_order < right.dotted_order ? -1 : 1))
        .map((child) => attributionOf(child.metadata));
    const source = namesARepository(root)
        ? root
        : inToolCallOrder.find((carried) => namesARepository(carried));
    const knowsWhoWorkedInSource = (carried) => carried[ATTRIBUTION_IDENTIFIER_KEY] !== undefined &&
        carried[REPOSITORY_NAME_KEY] === source?.[REPOSITORY_NAME_KEY];
    const author = root[ATTRIBUTION_IDENTIFIER_KEY] ??
        source?.[ATTRIBUTION_IDENTIFIER_KEY] ??
        inToolCallOrder.find(knowsWhoWorkedInSource)?.[ATTRIBUTION_IDENTIFIER_KEY];
    const filled = { ...source };
    if (author !== undefined)
        filled[ATTRIBUTION_IDENTIFIER_KEY] = author;
    return Object.keys(filled).length > 0 ? filled : undefined;
}
export function metadataAfterFill(run, filled) {
    const carried = attributionOf(run.metadata);
    const workedOutItsOwn = namesARepository(carried) && carried[REPOSITORY_NAME_KEY] !== filled[REPOSITORY_NAME_KEY];
    if (workedOutItsOwn)
        return undefined;
    const missing = Object.entries(filled).filter(([key]) => carried[key] === undefined);
    if (missing.length === 0)
        return undefined;
    return { ...run.metadata, ...Object.fromEntries(missing) };
}
export function settledTurnMetadata(base, record) {
    if (!record?.root)
        return base;
    const filled = turnAttribution({ ...record, root: { ...record.root, metadata: base ?? {} } });
    if (!filled)
        return base;
    const missing = Object.entries(filled).filter(([key]) => base?.[key] === undefined);
    return missing.length === 0 ? base : { ...base, ...Object.fromEntries(missing) };
}
//# sourceMappingURL=settlement.js.map