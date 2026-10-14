export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export function failureStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = Reflect.get(error, "status");
  return typeof status === "number" ? status : undefined;
}
