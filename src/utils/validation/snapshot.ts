export function snapshotData<T>(value: T): T {
  return copySnapshot(value, new WeakMap<object, object>()) as T;
}

function copySnapshot(value: unknown, copies: WeakMap<object, object>): unknown {
  if (value === null || typeof value !== "object") return value;
  const previous = copies.get(value);
  if (previous !== undefined) return previous;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Snapshot input must contain plain objects and arrays");
  }
  let copy: object;
  if (Array.isArray(value)) {
    const array: unknown[] = [];
    array.length = value.length;
    copy = array;
  } else {
    copy = Object.create(prototype);
  }
  copies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("Snapshot input must use data properties");
    }
    Object.defineProperty(copy, key, {
      value: copySnapshot(descriptor.value, copies),
      enumerable: descriptor.enumerable === true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}
