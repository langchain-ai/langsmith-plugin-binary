import { canonicalValue } from "../../storage/capture/utils/serialization.js";
import type { JsonValue } from "../../storage/capture/models.js";
import type { OwnDataField } from "./models.js";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export function requirePlainRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be a plain object`);
  return value;
}

export function ownDataField(source: Record<string, unknown>, key: PropertyKey): OwnDataField {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) return { present: false };
  return { present: true, value: descriptor.value };
}

export function requireOwnDataField(source: Record<string, unknown>, key: string): unknown {
  const field = ownDataField(source, key);
  if (!field.present) throw new TypeError(`${key} is required`);
  return field.value;
}

export function canonicalJsonValue(value: unknown): JsonValue {
  return canonicalValue(value, new Set<object>());
}

export function canonicalJsonObject(value: unknown, name: string): Record<string, unknown> {
  return canonicalValue(requirePlainRecord(value, name), new Set<object>()) as unknown as Record<
    string,
    unknown
  >;
}

export function canonicalJsonArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return canonicalValue(value, new Set<object>()) as unknown as unknown[];
}

export function requireNonBlankString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${name} is required`);
  return value;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

export function requireStringArray(value: unknown, name: string): string[] {
  const values = canonicalJsonArray(value, name);
  if (!values.every((entry) => typeof entry === "string"))
    throw new TypeError(`${name} must contain strings`);
  return values as string[];
}

export function requireTimestamp(value: unknown): number | string {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isFinite(new Date(value).getTime())
  ) {
    return value;
  }
  if (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(new Date(value).getTime())
  ) {
    return value;
  }
  throw new TypeError("Run timestamp must be a valid date or millisecond time");
}

export function requireSafeEpochMilliseconds(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new TypeError(`${name} must be a valid millisecond timestamp`);
  }
  return value;
}
