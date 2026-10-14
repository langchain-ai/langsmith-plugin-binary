import { join, resolve } from "node:path";
import {
  identifierHash,
  sessionSegments,
  validateIdentifier,
  validateIntegration,
} from "../../storage/capture/paths.js";
import {
  BACKGROUND_WORKER_ACTIVE_PREFIX,
  BACKGROUND_WORKER_FILE_PREFIX,
  BACKGROUND_WORKER_LAUNCHING_FILE,
  BACKGROUND_WORKER_LOCK_FILE,
  BACKGROUND_WORKER_PENDING_FILE,
} from "./constants.js";
import type { BackgroundWorkerScope } from "./models.js";

function validateWorkerScope(scope: BackgroundWorkerScope): void {
  validateIntegration(scope.integration);
  validateIdentifier(scope.sessionId, "session ID");
  validateIdentifier(scope.accountFingerprint, "account fingerprint");
}

export function workerDirectory(storageRoot: string, scope: BackgroundWorkerScope): string {
  validateWorkerScope(scope);
  return join(resolve(storageRoot), ...sessionSegments(identifierHash(scope.sessionId)));
}

export function workerLockPath(storageRoot: string, scope: BackgroundWorkerScope): string {
  return join(
    workerDirectory(storageRoot, scope),
    `${BACKGROUND_WORKER_LOCK_FILE}-${identifierHash(scope.accountFingerprint)}`,
  );
}

export function workerPendingPath(storageRoot: string, scope: BackgroundWorkerScope): string {
  return join(
    workerDirectory(storageRoot, scope),
    workerFileName(scope, BACKGROUND_WORKER_PENDING_FILE),
  );
}

export function workerActivePath(
  storageRoot: string,
  scope: BackgroundWorkerScope,
  markerId: string,
): string {
  return join(
    workerDirectory(storageRoot, scope),
    workerFileName(scope, `${BACKGROUND_WORKER_ACTIVE_PREFIX}${markerId}.json`),
  );
}

export function workerAttemptPath(
  storageRoot: string,
  scope: BackgroundWorkerScope,
  markerId: string,
  attempt: number,
): string {
  return join(
    workerDirectory(storageRoot, scope),
    workerFileName(scope, `${BACKGROUND_WORKER_ACTIVE_PREFIX}${markerId}.attempt.${attempt}.json`),
  );
}

export function workerLaunchPath(storageRoot: string, scope: BackgroundWorkerScope): string {
  return join(
    workerDirectory(storageRoot, scope),
    workerFileName(scope, BACKGROUND_WORKER_LAUNCHING_FILE),
  );
}

export function workerFileName(scope: BackgroundWorkerScope, name: string): string {
  return name.replace(
    BACKGROUND_WORKER_FILE_PREFIX,
    `${BACKGROUND_WORKER_FILE_PREFIX}-${identifierHash(scope.accountFingerprint)}`,
  );
}

export function scopedWorkerFileName(
  scope: BackgroundWorkerScope,
  name: string,
): string | undefined {
  const prefix = `${BACKGROUND_WORKER_FILE_PREFIX}-${identifierHash(scope.accountFingerprint)}.`;
  return name.startsWith(prefix)
    ? `${BACKGROUND_WORKER_FILE_PREFIX}.${name.slice(prefix.length)}`
    : undefined;
}
