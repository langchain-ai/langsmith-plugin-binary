import { scopedWorkerFileName } from "./paths.js";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { parseJsonObject } from "../../utils/validation/objects.js";
import { readPrivateFile } from "../../storage/capture/utils/atomic-file.js";
import { listPrivateDirectory } from "../../utils/files/private-directory.js";
import {
  BACKGROUND_WORKER_ACTIVE_MARKER_NAME,
  BACKGROUND_WORKER_ACTIVE_MARKER_PATH_MISMATCH_MESSAGE,
  BACKGROUND_WORKER_ATTEMPT_NAME,
  BACKGROUND_WORKER_ATTEMPT_VERSION,
  BACKGROUND_WORKER_INVALID_ACTIVE_PATH_MESSAGE,
  BACKGROUND_WORKER_INVALID_ATTEMPT_PATH_MESSAGE,
  BACKGROUND_WORKER_INVALID_MARKER_MESSAGE,
  BACKGROUND_WORKER_INVALID_RETRY_ATTEMPT_MESSAGE,
  BACKGROUND_WORKER_LAUNCHING_FILE,
  BACKGROUND_WORKER_MARKER_ID_PATTERN,
  BACKGROUND_WORKER_MARKER_VERSION,
  BACKGROUND_WORKER_MULTIPLE_ACTIVE_MARKERS_MESSAGE,
  BACKGROUND_WORKER_PENDING_FILE,
  BACKGROUND_WORKER_RETRY_SEQUENCE_HAS_GAP_MESSAGE,
  BACKGROUND_WORKER_STAGING_FILE,
  BACKGROUND_WORKER_STATE_DISAPPEARED_MESSAGE,
  BACKGROUND_WORKER_STATE_ERROR,
  BACKGROUND_WORKER_UNEXPECTED_STATE_PATH_MESSAGE,
  BACKGROUND_WORKER_SCOPED_FILE,
  BACKGROUND_WORKER_SHARED_DIRECTORY,
  BACKGROUND_WORKER_UNSAFE_ACTIVE_MARKER_MESSAGE,
  BACKGROUND_WORKER_UNSAFE_LAUNCH_MARKER_MESSAGE,
  BACKGROUND_WORKER_UNSAFE_LOCK_DIRECTORY_MESSAGE,
  BACKGROUND_WORKER_UNSAFE_PENDING_MARKER_MESSAGE,
  BACKGROUND_WORKER_UNSAFE_RETRY_ATTEMPT_MESSAGE,
  BACKGROUND_WORKER_UNSAFE_STAGING_FILE_MESSAGE,
} from "./constants.js";
import type {
  BackgroundWorkerAttempt,
  BackgroundWorkerMarker,
  BackgroundWorkerState,
  BackgroundWorkerStateScan,
  BackgroundWorkerScope,
} from "./models.js";

function assertPlainFile(entry: Dirent, message: string): void {
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(message);
}

async function readActiveMarker(
  storageRoot: string,
  directory: string,
  entry: Dirent,
  markerId: string | undefined,
  scan: BackgroundWorkerStateScan,
): Promise<void> {
  assertPlainFile(entry, BACKGROUND_WORKER_UNSAFE_ACTIVE_MARKER_MESSAGE);
  if (markerId === undefined || !BACKGROUND_WORKER_MARKER_ID_PATTERN.test(markerId))
    throw new Error(BACKGROUND_WORKER_INVALID_ACTIVE_PATH_MESSAGE);
  if (scan.active) throw new Error(BACKGROUND_WORKER_MULTIPLE_ACTIVE_MARKERS_MESSAGE);
  scan.active = parseMarker(await readRequired(storageRoot, join(directory, entry.name)));
  if (scan.active.id !== markerId)
    throw new Error(BACKGROUND_WORKER_ACTIVE_MARKER_PATH_MISMATCH_MESSAGE);
}

async function readAttemptFile(
  storageRoot: string,
  directory: string,
  entry: Dirent,
  match: RegExpExecArray,
  scan: BackgroundWorkerStateScan,
): Promise<void> {
  assertPlainFile(entry, BACKGROUND_WORKER_UNSAFE_RETRY_ATTEMPT_MESSAGE);
  const markerId = match[1];
  const attemptNumber = Number(match[2]);
  if (
    markerId === undefined ||
    !BACKGROUND_WORKER_MARKER_ID_PATTERN.test(markerId) ||
    !Number.isSafeInteger(attemptNumber)
  ) {
    throw new Error(BACKGROUND_WORKER_INVALID_ATTEMPT_PATH_MESSAGE);
  }
  const attempt = parseAttempt(
    await readRequired(storageRoot, join(directory, entry.name)),
    markerId,
    attemptNumber,
  );
  const markerAttempts = scan.attemptsByMarker.get(markerId) ?? [];
  markerAttempts.push(attempt);
  scan.attemptsByMarker.set(markerId, markerAttempts);
}

async function scanStateEntry(
  storageRoot: string,
  directory: string,
  entry: Dirent,
  scan: BackgroundWorkerStateScan,
  scope: BackgroundWorkerScope,
): Promise<void> {
  if (BACKGROUND_WORKER_SHARED_DIRECTORY.test(entry.name)) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(BACKGROUND_WORKER_UNSAFE_LOCK_DIRECTORY_MESSAGE);
    return;
  }
  const name = scopedWorkerFileName(scope, entry.name);
  if (name === undefined && BACKGROUND_WORKER_SCOPED_FILE.test(entry.name)) {
    assertPlainFile(entry, BACKGROUND_WORKER_UNSAFE_ACTIVE_MARKER_MESSAGE);
    return;
  }
  if (name === BACKGROUND_WORKER_PENDING_FILE) {
    assertPlainFile(entry, BACKGROUND_WORKER_UNSAFE_PENDING_MARKER_MESSAGE);
    scan.pending = parseMarker(await readRequired(storageRoot, join(directory, entry.name)));
    return;
  }
  const activeMatch = BACKGROUND_WORKER_ACTIVE_MARKER_NAME.exec(name ?? "");
  if (activeMatch) return readActiveMarker(storageRoot, directory, entry, activeMatch[1], scan);
  const attemptMatch = BACKGROUND_WORKER_ATTEMPT_NAME.exec(name ?? "");
  if (attemptMatch) return readAttemptFile(storageRoot, directory, entry, attemptMatch, scan);
  if (BACKGROUND_WORKER_STAGING_FILE.test(entry.name)) {
    assertPlainFile(entry, BACKGROUND_WORKER_UNSAFE_STAGING_FILE_MESSAGE);
    return;
  }
  if (name === BACKGROUND_WORKER_LAUNCHING_FILE) {
    assertPlainFile(entry, BACKGROUND_WORKER_UNSAFE_LAUNCH_MARKER_MESSAGE);
    return;
  }
  throw new Error(BACKGROUND_WORKER_UNEXPECTED_STATE_PATH_MESSAGE);
}

function stateFromScan({
  pending,
  active,
  attemptsByMarker,
}: BackgroundWorkerStateScan): BackgroundWorkerState {
  const attempts = active ? (attemptsByMarker.get(active.id) ?? []) : [];
  attempts.sort((left, right) => left.attempt - right.attempt);
  for (let index = 0; index < attempts.length; index += 1) {
    if (attempts[index]?.attempt !== index + 1)
      throw new Error(BACKGROUND_WORKER_RETRY_SEQUENCE_HAS_GAP_MESSAGE);
  }
  const orphanedAttempts = [...attemptsByMarker.entries()]
    .filter(([markerId]) => active?.id !== markerId)
    .flatMap(([, markerAttempts]) => markerAttempts);
  return {
    ...(pending ? { pending } : {}),
    ...(active ? { active } : {}),
    attempts,
    orphanedAttempts,
  };
}

export async function readWorkerState(
  storageRoot: string,
  directory: string,
  scope: BackgroundWorkerScope,
): Promise<BackgroundWorkerState> {
  const entries = await listPrivateDirectory(storageRoot, directory);
  if (!entries) return { attempts: [], orphanedAttempts: [] };
  const scan: BackgroundWorkerStateScan = { attemptsByMarker: new Map() };
  for (const entry of entries) await scanStateEntry(storageRoot, directory, entry, scan, scope);
  return stateFromScan(scan);
}

async function readRequired(storageRoot: string, path: string): Promise<string> {
  const contents = await readPrivateFile(storageRoot, path);
  if (contents === undefined) throw new Error(BACKGROUND_WORKER_STATE_DISAPPEARED_MESSAGE);
  return contents;
}

function parseMarker(contents: string): BackgroundWorkerMarker {
  const value = parseJsonObject(contents, BACKGROUND_WORKER_STATE_ERROR);
  if (
    value.version !== BACKGROUND_WORKER_MARKER_VERSION ||
    typeof value.id !== "string" ||
    !BACKGROUND_WORKER_MARKER_ID_PATTERN.test(value.id) ||
    typeof value.sourcePid !== "number" ||
    !Number.isSafeInteger(value.sourcePid) ||
    value.sourcePid <= 0
  ) {
    throw new Error(BACKGROUND_WORKER_INVALID_MARKER_MESSAGE);
  }
  return value as unknown as BackgroundWorkerMarker;
}

function parseAttempt(
  contents: string,
  markerId: string,
  attempt: number,
): BackgroundWorkerAttempt {
  const value = parseJsonObject(contents, BACKGROUND_WORKER_STATE_ERROR);
  if (
    value.version !== BACKGROUND_WORKER_ATTEMPT_VERSION ||
    value.markerId !== markerId ||
    value.attempt !== attempt
  ) {
    throw new Error(BACKGROUND_WORKER_INVALID_RETRY_ATTEMPT_MESSAGE);
  }
  return value as unknown as BackgroundWorkerAttempt;
}
