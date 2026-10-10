import type { JsonValue } from "../models.js";
import { JSON_ARRAY_INDEX_KEY } from "../constants.js";

export function canonicalJson(value: unknown): string {
  const result = JSON.stringify(canonicalValue(value, new Set<object>()));
  if (result === undefined) throw new TypeError("Value cannot be serialized as JSON");
  return result;
}

export function canonicalValue(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Cyclic data cannot be captured");
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key === "symbol" ||
          (key !== "length" && (!JSON_ARRAY_INDEX_KEY.test(key) || Number(key) >= value.length)),
      )
    ) {
      throw new TypeError("Array properties cannot be captured");
    }
    if (Object.keys(descriptors).length - 1 < value.length)
      throw new TypeError("Sparse arrays cannot be captured");
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor?.enumerable || !("value" in descriptor))
        throw new TypeError("Sparse arrays cannot be captured");
      result.push(canonicalValue(descriptor.value, seen));
    }
    seen.delete(value);
    return result;
  }
  if (
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError("Capture data must contain only JSON values");
  }
  if (seen.has(value)) throw new TypeError("Cyclic data cannot be captured");
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol"))
    throw new TypeError("Symbol keys cannot be captured");
  const result = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(descriptors).toSorted()) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new TypeError("Capture data must use enumerable data fields");
    result[key] = canonicalValue(descriptor.value, seen);
  }
  seen.delete(value);
  return result;
}
