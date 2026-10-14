export function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
export function errorCode(error) {
    return error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : undefined;
}
export function failureStatus(error) {
    if (typeof error !== "object" || error === null)
        return undefined;
    const status = Reflect.get(error, "status");
    return typeof status === "number" ? status : undefined;
}
//# sourceMappingURL=errors.js.map