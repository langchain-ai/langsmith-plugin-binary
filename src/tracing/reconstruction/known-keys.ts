export function assertKnownKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  message: string,
): void {
  const keys = Object.keys(record);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new TypeError(message);
}
