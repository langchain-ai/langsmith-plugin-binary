import { resolve } from "node:path";
import { CAPTURE_DIRECTORY, CAPTURE_RECORD_VERSION, CAPTURE_RECEIPT_VERSION } from "./constants.js";
import type {
  CaptureScope,
  CaptureStore,
  OutcomeInput,
  OutcomeReadResult,
  OutcomeReceipt,
  StorageFailure,
  StoredCapture,
} from "./models.js";
import {
  eventPath,
  identifierHash,
  receiptPath,
  validateIdentifier,
  validateIntegration,
} from "./paths.js";
import { ensurePrivateDirectory, publishExclusive, readPrivateFile } from "./utils/atomic-file.js";
import { canonicalJson, canonicalValue } from "./utils/serialization.js";

export function createCaptureStore(root: string): CaptureStore {
  const storageRoot = resolve(root);
  return {
    async capture(input) {
      let record: StoredCapture;
      let contents: string;
      try {
        validateScope(input);
        validateIdentifier(input.runId, "run ID");
        validateIdentifier(input.destinationFingerprint, "destination fingerprint");
        validateIdentifier(input.eventKind, "event kind");
        record = {
          version: CAPTURE_RECORD_VERSION,
          integration: input.integration,
          sessionId: input.sessionId,
          turnId: input.turnId,
          eventId: input.eventId,
          runId: input.runId,
          destinationFingerprint: input.destinationFingerprint,
          eventKind: input.eventKind,
          normalizedPayload: canonicalValue(input.normalizedPayload, new Set<object>()),
          turnEvidence: canonicalValue(input.turnEvidence, new Set<object>()),
          metadataProvenance: canonicalValue(input.metadataProvenance, new Set<object>()),
        };
        contents = canonicalJson(record);
      } catch (error) {
        return failure("SERIALIZATION_FAILED", error);
      }
      try {
        const path = eventPath(storageRoot, input);
        await ensureDirectories(input.integration, input.sessionId, input.turnId, "events");
        if (await publishExclusive(path, contents)) return { status: "published", record };
        const previous = await readRecord(storageRoot, path);
        if (previous === undefined)
          return {
            status: "failed",
            code: "STORAGE_FAILED",
            message: "Published event disappeared",
          };
        if (!sameScope(previous, input)) return { status: "conflict" };
        return canonicalJson(previous) === contents
          ? { status: "duplicate", record: previous }
          : { status: "conflict" };
      } catch (error) {
        return failure("STORAGE_FAILED", error);
      }
    },
    async read(scope) {
      validateScope(scope);
      const record = await readRecord(storageRoot, eventPath(storageRoot, scope));
      if (record === undefined) return undefined;
      if (!sameScope(record, scope)) throw new Error("Capture namespace does not match");
      return record;
    },
    async recordOutcome(input) {
      try {
        validateScope(input);
        validateIdentifier(input.destination, "destination");
        if (input.outcome !== "delivered" && input.outcome !== "dropped")
          throw new TypeError("Invalid outcome");
        if (input.reason !== undefined) validateIdentifier(input.reason, "outcome reason");
        if ((await this.read(input)) === undefined) return { status: "missing-capture" };
        const path = receiptPath(storageRoot, input, input.destination);
        await ensureDirectories(
          input.integration,
          input.sessionId,
          input.turnId,
          "receipts",
          input.destination,
        );
        const comparable = receiptValue(input, new Date().toISOString());
        const contents = canonicalJson(comparable);
        if (await publishExclusive(path, contents))
          return { status: "recorded", receipt: comparable };
        const previous = await readReceipt(storageRoot, path);
        if (previous === undefined)
          return {
            status: "failed",
            code: "STORAGE_FAILED",
            message: "Published receipt disappeared",
          };
        return sameReceipt(previous, input)
          ? { status: "duplicate", receipt: previous }
          : { status: "conflict" };
      } catch (error) {
        return failure("STORAGE_FAILED", error);
      }
    },
    async readOutcome(scope, destination): Promise<OutcomeReadResult> {
      try {
        validateScope(scope);
        validateIdentifier(destination, "destination");
        if ((await this.read(scope)) === undefined) return { status: "missing-capture" };
        const receipt = await readReceipt(
          storageRoot,
          receiptPath(storageRoot, scope, destination),
        );
        if (receipt === undefined) return { status: "pending" };
        return sameScope(receipt, scope) && receipt.destination === destination
          ? { status: "settled", receipt }
          : {
              status: "failed",
              code: "STORAGE_FAILED",
              message: "Receipt namespace does not match",
            };
      } catch (error) {
        return failure("STORAGE_FAILED", error);
      }
    },
  };

  async function ensureDirectories(
    integration: string,
    sessionId: string,
    turnId: string,
    collection: "events" | "receipts",
    destination?: string,
  ): Promise<void> {
    const pathSegments = [
      CAPTURE_DIRECTORY,
      "integrations",
      integration,
      "sessions",
      identifierHash(sessionId),
      "turns",
      identifierHash(turnId),
      collection,
    ];
    if (destination !== undefined) pathSegments.push(identifierHash(destination));
    await ensurePrivateDirectory(storageRoot, pathSegments);
  }
}

function receiptValue(input: OutcomeInput, recordedAt: string): OutcomeReceipt {
  return {
    version: CAPTURE_RECEIPT_VERSION,
    integration: input.integration,
    sessionId: input.sessionId,
    turnId: input.turnId,
    eventId: input.eventId,
    destination: input.destination,
    outcome: input.outcome,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    recordedAt,
  };
}

async function readRecord(root: string, path: string): Promise<StoredCapture | undefined> {
  const contents = await readPrivateFile(root, path);
  if (contents === undefined) return undefined;
  const value = parseObject(contents);
  if (
    value.version !== CAPTURE_RECORD_VERSION ||
    typeof value.integration !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.eventId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.destinationFingerprint !== "string" ||
    typeof value.eventKind !== "string" ||
    !("normalizedPayload" in value) ||
    !("turnEvidence" in value) ||
    !("metadataProvenance" in value)
  ) {
    throw new Error("Unsupported capture record");
  }
  for (const [identifier, name] of [
    [value.runId, "run ID"],
    [value.destinationFingerprint, "destination fingerprint"],
    [value.eventKind, "event kind"],
  ] as const) {
    validateIdentifier(identifier as string, name);
  }
  return value as unknown as StoredCapture;
}

async function readReceipt(root: string, path: string): Promise<OutcomeReceipt | undefined> {
  const contents = await readPrivateFile(root, path);
  if (contents === undefined) return undefined;
  const value = parseObject(contents);
  if (
    value.version !== CAPTURE_RECEIPT_VERSION ||
    typeof value.integration !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.eventId !== "string" ||
    typeof value.destination !== "string" ||
    (value.outcome !== "delivered" && value.outcome !== "dropped") ||
    typeof value.recordedAt !== "string" ||
    ("reason" in value && typeof value.reason !== "string")
  ) {
    throw new Error("Unsupported outcome receipt");
  }
  validateIdentifier(value.destination, "destination");
  if ("reason" in value) validateIdentifier(value.reason as string, "outcome reason");
  const recordedAt = new Date(value.recordedAt);
  if (!Number.isFinite(recordedAt.getTime()) || recordedAt.toISOString() !== value.recordedAt)
    throw new Error("Unsupported outcome receipt");
  return value as unknown as OutcomeReceipt;
}

function parseObject(contents: string): Record<string, unknown> {
  const value: unknown = JSON.parse(contents);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid storage record");
  return value as Record<string, unknown>;
}

function validateScope(scope: CaptureScope): void {
  validateIntegration(scope.integration);
  validateIdentifier(scope.sessionId, "session ID");
  validateIdentifier(scope.turnId, "turn ID");
  validateIdentifier(scope.eventId, "event ID");
}

function sameScope(record: CaptureScope, scope: CaptureScope): boolean {
  return (
    record.integration === scope.integration &&
    record.sessionId === scope.sessionId &&
    record.turnId === scope.turnId &&
    record.eventId === scope.eventId
  );
}

function sameReceipt(receipt: OutcomeReceipt, input: OutcomeInput): boolean {
  return (
    sameScope(receipt, input) &&
    receipt.destination === input.destination &&
    receipt.outcome === input.outcome &&
    receipt.reason === input.reason
  );
}

function failure(code: string, error: unknown): StorageFailure {
  return {
    status: "failed",
    code: errorCode(error) ?? code,
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
