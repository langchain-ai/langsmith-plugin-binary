import { join, resolve } from "node:path";
import {
  identifierHash,
  validateIdentifier,
  validateIntegration,
} from "../../storage/capture/paths.js";
import {
  BACKGROUND_WORKER_ACCOUNTS_DIRECTORY,
  BACKGROUND_WORKER_ACTIVE_PREFIX,
  BACKGROUND_WORKER_DIRECTORY,
  BACKGROUND_WORKER_INTEGRATIONS_DIRECTORY,
  BACKGROUND_WORKER_LAUNCHING_FILE,
  BACKGROUND_WORKER_LOCK_FILE,
  BACKGROUND_WORKER_PENDING_FILE,
} from "./constants.js";
import type { BackgroundWorkerScope } from "./models.js";

export function validateWorkerScope(scope: BackgroundWorkerScope): void {
  validateIntegration(scope.integration);
  validateIdentifier(scope.accountFingerprint, "account fingerprint");
}

export function workerDirectory(storageRoot: string, scope: BackgroundWorkerScope): string {
  validateWorkerScope(scope);
  return join(
    resolve(storageRoot),
    BACKGROUND_WORKER_DIRECTORY,
    BACKGROUND_WORKER_INTEGRATIONS_DIRECTORY,
    scope.integration,
    BACKGROUND_WORKER_ACCOUNTS_DIRECTORY,
    identifierHash(scope.accountFingerprint),
  );
}

export function workerLockPath(storageRoot: string, scope: BackgroundWorkerScope): string {
  return join(workerDirectory(storageRoot, scope), BACKGROUND_WORKER_LOCK_FILE);
}

export function workerPendingPath(storageRoot: string, scope: BackgroundWorkerScope): string {
  return join(workerDirectory(storageRoot, scope), BACKGROUND_WORKER_PENDING_FILE);
}

export function workerActivePath(
  storageRoot: string,
  scope: BackgroundWorkerScope,
  markerId: string,
): string {
  return join(
    workerDirectory(storageRoot, scope),
    `${BACKGROUND_WORKER_ACTIVE_PREFIX}${markerId}.json`,
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
    `${BACKGROUND_WORKER_ACTIVE_PREFIX}${markerId}.attempt.${attempt}.json`,
  );
}

export function workerLaunchPath(storageRoot: string, scope: BackgroundWorkerScope): string {
  return join(workerDirectory(storageRoot, scope), BACKGROUND_WORKER_LAUNCHING_FILE);
}
