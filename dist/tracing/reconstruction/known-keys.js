export function assertKnownKeys(record, required, optional, message) {
    const keys = Object.keys(record);
    if (required.some((key) => !keys.includes(key)) ||
        keys.some((key) => !required.includes(key) && !optional.includes(key)))
        throw new TypeError(message);
}
//# sourceMappingURL=known-keys.js.map