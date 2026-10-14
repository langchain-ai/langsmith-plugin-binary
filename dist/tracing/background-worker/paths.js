import { join, resolve } from "node:path";
import { identifierHash, sessionSegments, validateIdentifier, validateIntegration, } from "../../storage/capture/paths.js";
import { BACKGROUND_WORKER_ACTIVE_PREFIX, BACKGROUND_WORKER_FILE_PREFIX, BACKGROUND_WORKER_LAUNCHING_FILE, BACKGROUND_WORKER_LOCK_FILE, BACKGROUND_WORKER_PENDING_FILE, } from "./constants.js";
function validateWorkerScope(scope) {
    validateIntegration(scope.integration);
    validateIdentifier(scope.sessionId, "session ID");
    validateIdentifier(scope.accountFingerprint, "account fingerprint");
}
export function workerDirectory(storageRoot, scope) {
    validateWorkerScope(scope);
    return join(resolve(storageRoot), ...sessionSegments(identifierHash(scope.sessionId)));
}
export function workerLockPath(storageRoot, scope) {
    return join(workerDirectory(storageRoot, scope), `${BACKGROUND_WORKER_LOCK_FILE}-${identifierHash(scope.accountFingerprint)}`);
}
export function workerPendingPath(storageRoot, scope) {
    return join(workerDirectory(storageRoot, scope), workerFileName(scope, BACKGROUND_WORKER_PENDING_FILE));
}
export function workerActivePath(storageRoot, scope, markerId) {
    return join(workerDirectory(storageRoot, scope), workerFileName(scope, `${BACKGROUND_WORKER_ACTIVE_PREFIX}${markerId}.json`));
}
export function workerAttemptPath(storageRoot, scope, markerId, attempt) {
    return join(workerDirectory(storageRoot, scope), workerFileName(scope, `${BACKGROUND_WORKER_ACTIVE_PREFIX}${markerId}.attempt.${attempt}.json`));
}
export function workerLaunchPath(storageRoot, scope) {
    return join(workerDirectory(storageRoot, scope), workerFileName(scope, BACKGROUND_WORKER_LAUNCHING_FILE));
}
export function workerFileName(scope, name) {
    return name.replace(BACKGROUND_WORKER_FILE_PREFIX, `${BACKGROUND_WORKER_FILE_PREFIX}-${identifierHash(scope.accountFingerprint)}`);
}
export function scopedWorkerFileName(scope, name) {
    const prefix = `${BACKGROUND_WORKER_FILE_PREFIX}-${identifierHash(scope.accountFingerprint)}.`;
    return name.startsWith(prefix)
        ? `${BACKGROUND_WORKER_FILE_PREFIX}.${name.slice(prefix.length)}`
        : undefined;
}
//# sourceMappingURL=paths.js.map