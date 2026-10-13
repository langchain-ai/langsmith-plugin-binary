import { join, resolve } from "node:path";
import {
  DELIVERY_ATTEMPT_FILE,
  DELIVERY_ATTEMPT_VERSION,
  DELIVERY_DIRECTORY,
  DELIVERY_STAGING_FILE,
} from "./constants.js";
import type { DeliveryAttempt, DeliveryAttemptStore } from "./models.js";
import {
  identifierHash,
  validateIdentifier,
  validateIntegration,
} from "../../storage/capture/paths.js";
import type { CaptureScope } from "../../storage/capture/models.js";
import {
  ensurePrivateDirectory,
  publishExclusive,
  readPrivateFile,
} from "../../storage/capture/utils/atomic-file.js";
import { listPrivateDirectory } from "../../utils/files/private-directory.js";

export function createDeliveryAttemptStore(root: string): DeliveryAttemptStore {
  const storageRoot = resolve(root);
  return {
    async count(scope, destination) {
      validateAttemptScope(scope, destination);
      const directory = attemptDirectory(storageRoot, scope, destination);
      const entries = await listPrivateDirectory(storageRoot, directory);
      if (entries === undefined) return 0;
      const attempts: number[] = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile())
          throw new Error("Delivery attempt must be a regular file");
        if (DELIVERY_STAGING_FILE.test(entry.name)) continue;
        const match = DELIVERY_ATTEMPT_FILE.exec(entry.name);
        if (!match) throw new Error("Invalid delivery attempt path");
        const attempt = Number(match[1]);
        if (!Number.isSafeInteger(attempt) || String(attempt) !== match[1])
          throw new Error("Invalid delivery attempt number");
        const contents = await readPrivateFile(storageRoot, join(directory, entry.name));
        if (contents === undefined) throw new Error("Delivery attempt disappeared");
        const record = parseAttempt(contents);
        if (!sameAttempt(record, scope, destination, attempt))
          throw new Error("Delivery attempt namespace does not match");
        attempts.push(attempt);
      }
      attempts.sort((left, right) => left - right);
      for (let index = 0; index < attempts.length; index += 1) {
        if (attempts[index] !== index + 1) throw new Error("Delivery attempt sequence has a gap");
      }
      return attempts.length;
    },
    async record(scope, destination, attempt, startedAt) {
      validateAttemptScope(scope, destination);
      if (!Number.isSafeInteger(attempt) || attempt <= 0)
        throw new TypeError("Invalid delivery attempt number");
      validateTimestamp(startedAt);
      const directory = attemptDirectory(storageRoot, scope, destination);
      await ensurePrivateDirectory(storageRoot, attemptSegments(scope, destination));
      const record: DeliveryAttempt = {
        version: DELIVERY_ATTEMPT_VERSION,
        ...scope,
        destination,
        attempt,
        startedAt,
      };
      const published = await publishExclusive(
        join(directory, `${attempt}.json`),
        JSON.stringify(record),
      );
      if (!published) throw new Error("Delivery attempt already exists");
    },
  };
}

function attemptSegments(scope: CaptureScope, destination: string): string[] {
  return [
    DELIVERY_DIRECTORY,
    "integrations",
    scope.integration,
    "sessions",
    identifierHash(scope.sessionId),
    "turns",
    identifierHash(scope.turnId),
    "events",
    identifierHash(scope.eventId),
    "destinations",
    identifierHash(destination),
    "attempts",
  ];
}

function attemptDirectory(root: string, scope: CaptureScope, destination: string): string {
  return join(root, ...attemptSegments(scope, destination));
}

function validateAttemptScope(scope: CaptureScope, destination: string): void {
  validateIntegration(scope.integration);
  validateIdentifier(scope.sessionId, "session ID");
  validateIdentifier(scope.turnId, "turn ID");
  validateIdentifier(scope.eventId, "event ID");
  validateIdentifier(destination, "destination");
}

function parseAttempt(contents: string): DeliveryAttempt {
  const value = JSON.parse(contents) as unknown;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== DELIVERY_ATTEMPT_VERSION ||
    !("integration" in value) ||
    typeof value.integration !== "string" ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("turnId" in value) ||
    typeof value.turnId !== "string" ||
    !("eventId" in value) ||
    typeof value.eventId !== "string" ||
    !("destination" in value) ||
    typeof value.destination !== "string" ||
    !("attempt" in value) ||
    typeof value.attempt !== "number" ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string"
  ) {
    throw new Error("Unsupported delivery attempt");
  }
  const record = value as unknown as DeliveryAttempt;
  validateAttemptScope(record, record.destination);
  if (!Number.isSafeInteger(record.attempt) || record.attempt <= 0)
    throw new Error("Invalid delivery attempt number");
  validateTimestamp(record.startedAt);
  return record;
}

function sameAttempt(
  record: DeliveryAttempt,
  scope: CaptureScope,
  destination: string,
  attempt: number,
): boolean {
  return (
    record.integration === scope.integration &&
    record.sessionId === scope.sessionId &&
    record.turnId === scope.turnId &&
    record.eventId === scope.eventId &&
    record.destination === destination &&
    record.attempt === attempt
  );
}

function validateTimestamp(value: string): void {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value)
    throw new TypeError("Invalid delivery attempt timestamp");
}
