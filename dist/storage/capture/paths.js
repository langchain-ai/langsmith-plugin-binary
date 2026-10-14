import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { CAPTURE_SESSIONS_DIRECTORY, CAPTURE_FILE_EXTENSION, CAPTURE_LOCK_EXTENSION, CAPTURE_TURNS_DIRECTORY, CAPTURE_JOBS_DIRECTORY, CAPTURE_STORAGE_DIRECTORY_MESSAGE, CAPTURE_INTEGRATION, CAPTURE_MAX_IDENTIFIER_BYTES, } from "./constants.js";
export function validateIntegration(value) {
    if (!CAPTURE_INTEGRATION.test(value))
        throw new TypeError("Invalid integration namespace");
}
export function validateIdentifier(value, name) {
    if (value.length === 0 ||
        Buffer.byteLength(value, "utf8") > CAPTURE_MAX_IDENTIFIER_BYTES ||
        hasControlCharacter(value)) {
        throw new TypeError(`Invalid ${name}`);
    }
}
function hasControlCharacter(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && (codePoint < 32 || codePoint === 127))
            return true;
    }
    return false;
}
export function identifierHash(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function captureRoot(storage) {
    return typeof storage === "string" ? resolve(storage) : storage.root;
}
export function captureDirectory(storage) {
    const directory = typeof storage === "string" ? CAPTURE_TURNS_DIRECTORY : storage.directory;
    if (directory !== CAPTURE_TURNS_DIRECTORY && directory !== CAPTURE_JOBS_DIRECTORY)
        throw new TypeError(CAPTURE_STORAGE_DIRECTORY_MESSAGE);
    return directory;
}
export function sessionSegments(sessionHash) {
    return [CAPTURE_SESSIONS_DIRECTORY, sessionHash];
}
export function eventSegments(storage, scope) {
    const segments = [...sessionSegments(identifierHash(scope.sessionId)), captureDirectory(storage)];
    return captureDirectory(storage) === CAPTURE_TURNS_DIRECTORY
        ? [...segments, identifierHash(scope.turnId)]
        : segments;
}
export function sessionsDirectory(root, integration) {
    validateIntegration(integration);
    return join(captureRoot(root), CAPTURE_SESSIONS_DIRECTORY);
}
export function turnsDirectory(root, integration, sessionHash) {
    return join(sessionsDirectory(root, integration), sessionHash, captureDirectory(root));
}
export function eventsDirectory(turns, turnHash) {
    return join(turns, turnHash);
}
export function eventPath(root, scope) {
    const eventId = captureDirectory(root) === CAPTURE_TURNS_DIRECTORY
        ? scope.eventId
        : JSON.stringify([scope.turnId, scope.eventId]);
    return join(captureRoot(root), ...eventSegments(root, scope), `${identifierHash(eventId)}${CAPTURE_FILE_EXTENSION}`);
}
export function recordLockPath(root, scope) {
    const path = eventPath(root, scope);
    return `${path.slice(0, -CAPTURE_FILE_EXTENSION.length)}${CAPTURE_LOCK_EXTENSION}`;
}
//# sourceMappingURL=paths.js.map