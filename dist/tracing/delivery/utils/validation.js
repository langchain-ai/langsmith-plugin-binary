import { validateIdentifier, validateIntegration } from "../../../storage/capture/paths.js";
import { requirePlainRecord, requireString } from "../../../utils/validation/objects.js";
import { DELIVERY_ATTEMPT_FILE, DELIVERY_STAGING_FILE, DELIVERY_ATTEMPT_VERSION, } from "../constants.js";
export function validateAttemptScope(scope, destination) {
    validateIntegration(scope.integration);
    validateIdentifier(scope.sessionId, "session ID");
    validateIdentifier(scope.turnId, "turn ID");
    validateIdentifier(scope.eventId, "event ID");
    validateIdentifier(destination, "destination");
}
export function parseAttempt(contents) {
    const value = requirePlainRecord(JSON.parse(contents), "Delivery attempt");
    if (value.version !== DELIVERY_ATTEMPT_VERSION)
        throw new Error("Unsupported delivery attempt");
    const record = {
        version: DELIVERY_ATTEMPT_VERSION,
        integration: requireString(value.integration, "integration"),
        sessionId: requireString(value.sessionId, "sessionId"),
        turnId: requireString(value.turnId, "turnId"),
        eventId: requireString(value.eventId, "eventId"),
        destination: requireString(value.destination, "destination"),
        attempt: requireAttemptNumber(value.attempt),
        startedAt: requireString(value.startedAt, "startedAt"),
    };
    validateAttemptScope(record, record.destination);
    validateTimestamp(record.startedAt);
    return record;
}
export function sameAttempt(record, scope, destination, attempt) {
    return (record.integration === scope.integration &&
        record.sessionId === scope.sessionId &&
        record.turnId === scope.turnId &&
        record.eventId === scope.eventId &&
        record.destination === destination &&
        record.attempt === attempt);
}
export function validateTimestamp(value) {
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value)
        throw new TypeError("Invalid delivery attempt timestamp");
}
export function readAttemptFileNumber(entry) {
    if (entry.isSymbolicLink() || !entry.isFile())
        throw new Error("Delivery attempt must be a regular file");
    if (DELIVERY_STAGING_FILE.test(entry.name))
        return undefined;
    const match = DELIVERY_ATTEMPT_FILE.exec(entry.name);
    if (!match)
        throw new Error("Invalid delivery attempt path");
    const attempt = Number(match[1]);
    if (!Number.isSafeInteger(attempt) || String(attempt) !== match[1])
        throw new Error("Invalid delivery attempt number");
    return attempt;
}
export function validateAttemptSequence(attempts) {
    attempts.sort((left, right) => left - right);
    if (attempts.some((attempt, index) => attempt !== index + 1))
        throw new Error("Delivery attempt sequence has a gap");
}
export function requireAttemptNumber(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        throw new TypeError("Invalid delivery attempt number");
    return value;
}
//# sourceMappingURL=validation.js.map