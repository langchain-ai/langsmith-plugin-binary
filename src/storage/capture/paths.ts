import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import {
  CAPTURE_DIRECTORY,
  CAPTURE_INTEGRATION,
  CAPTURE_MAX_IDENTIFIER_BYTES,
} from "./constants.js";
import type { CaptureScope } from "./models.js";

export function validateIntegration(value: string): void {
  if (!CAPTURE_INTEGRATION.test(value)) throw new TypeError("Invalid integration namespace");
}

export function validateIdentifier(value: string, name: string): void {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > CAPTURE_MAX_IDENTIFIER_BYTES ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`Invalid ${name}`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}

export function identifierHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function captureDirectory(root: string): string {
  return join(resolve(root), CAPTURE_DIRECTORY);
}

export function eventPath(root: string, scope: CaptureScope): string {
  return join(
    captureDirectory(root),
    "integrations",
    scope.integration,
    "sessions",
    identifierHash(scope.sessionId),
    "turns",
    identifierHash(scope.turnId),
    "events",
    `${identifierHash(scope.eventId)}.json`,
  );
}

export function receiptPath(root: string, scope: CaptureScope, destination: string): string {
  return join(
    captureDirectory(root),
    "integrations",
    scope.integration,
    "sessions",
    identifierHash(scope.sessionId),
    "turns",
    identifierHash(scope.turnId),
    "receipts",
    identifierHash(destination),
    `${identifierHash(scope.eventId)}.json`,
  );
}
