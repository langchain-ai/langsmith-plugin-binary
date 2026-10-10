import { canonicalValue } from "../../storage/capture/utils/serialization.js";
export function isPlainRecord(value) {
    return (value !== null &&
        typeof value === "object" &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}
export function requirePlainRecord(value, name) {
    if (!isPlainRecord(value))
        throw new TypeError(`${name} must be a plain object`);
    return value;
}
export function ownDataField(source, key) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor?.enumerable || !("value" in descriptor))
        return { present: false };
    return { present: true, value: descriptor.value };
}
export function requireOwnDataField(source, key) {
    const field = ownDataField(source, key);
    if (!field.present)
        throw new TypeError(`${key} is required`);
    return field.value;
}
export function canonicalJsonValue(value) {
    return canonicalValue(value, new Set());
}
export function canonicalJsonObject(value, name) {
    return canonicalValue(requirePlainRecord(value, name), new Set());
}
export function canonicalJsonArray(value, name) {
    if (!Array.isArray(value))
        throw new TypeError(`${name} must be an array`);
    return canonicalValue(value, new Set());
}
export function requireNonBlankString(value, name) {
    if (typeof value !== "string" || value.trim().length === 0)
        throw new TypeError(`${name} is required`);
    return value;
}
export function requireString(value, name) {
    if (typeof value !== "string")
        throw new TypeError(`${name} must be a string`);
    return value;
}
export function requireStringArray(value, name) {
    const values = canonicalJsonArray(value, name);
    if (!values.every((entry) => typeof entry === "string"))
        throw new TypeError(`${name} must contain strings`);
    return values;
}
export function requireTimestamp(value) {
    if (typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isFinite(new Date(value).getTime())) {
        return value;
    }
    if (typeof value === "string" &&
        value.trim().length > 0 &&
        Number.isFinite(new Date(value).getTime())) {
        return value;
    }
    throw new TypeError("Run timestamp must be a valid date or millisecond time");
}
//# sourceMappingURL=objects.js.map