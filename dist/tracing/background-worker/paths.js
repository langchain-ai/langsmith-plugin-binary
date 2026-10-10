import { join, resolve } from "node:path";
import { identifierHash, validateIdentifier, validateIntegration, } from "../../storage/capture/paths.js";
import { BACKGROUND_WORKER_ACCOUNTS_DIRECTORY, BACKGROUND_WORKER_ACTIVE_PREFIX, BACKGROUND_WORKER_DIRECTORY, BACKGROUND_WORKER_INTEGRATIONS_DIRECTORY, BACKGROUND_WORKER_LAUNCHING_FILE, BACKGROUND_WORKER_LOCK_FILE, BACKGROUND_WORKER_PENDING_FILE, } from "./constants.js";
export function validateWorkerScope(scope) {
    validateIntegration(scope.integration);
    validateIdentifier(scope.accountFingerprint, "account fingerprint");
}
export function workerDirectory(storageRoot, scope) {
    validateWorkerScope(scope);
    return join(resolve(storageRoot), BACKGROUND_WORKER_DIRECTORY, BACKGROUND_WORKER_INTEGRATIONS_DIRECTORY, scope.integration, BACKGROUND_WORKER_ACCOUNTS_DIRECTORY, identifierHash(scope.accountFingerprint));
}
export function workerLockPath(storageRoot, scope) {
    return join(workerDirectory(storageRoot, scope), BACKGROUND_WORKER_LOCK_FILE);
}
export function workerPendingPath(storageRoot, scope) {
    return join(workerDirectory(storageRoot, scope), BACKGROUND_WORKER_PENDING_FILE);
}
export function workerActivePath(storageRoot, scope, markerId) {
    return join(workerDirectory(storageRoot, scope), `${BACKGROUND_WORKER_ACTIVE_PREFIX}${markerId}.json`);
}
export function workerAttemptPath(storageRoot, scope, markerId, attempt) {
    return join(workerDirectory(storageRoot, scope), `${BACKGROUND_WORKER_ACTIVE_PREFIX}${markerId}.attempt.${attempt}.json`);
}
export function workerLaunchPath(storageRoot, scope) {
    return join(workerDirectory(storageRoot, scope), BACKGROUND_WORKER_LAUNCHING_FILE);
}
//# sourceMappingURL=paths.js.map