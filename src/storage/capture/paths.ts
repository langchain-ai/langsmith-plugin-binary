import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import {
  CAPTURE_DIRECTORY,
  CAPTURE_EVENTS_DIRECTORY,
  CAPTURE_INTEGRATIONS_DIRECTORY,
  CAPTURE_SESSIONS_DIRECTORY,
  CAPTURE_TURNS_DIRECTORY,
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

function captureDirectory(root: string): string {
  return join(resolve(root), CAPTURE_DIRECTORY);
}

export function sessionSegments(base: string, integration: string, sessionHash: string): string[] {
  return [
    base,
    CAPTURE_INTEGRATIONS_DIRECTORY,
    integration,
    CAPTURE_SESSIONS_DIRECTORY,
    sessionHash,
  ];
}

export function eventSegments(
  base: string,
  scope: Pick<CaptureScope, "integration" | "sessionId" | "turnId">,
): string[] {
  return [
    ...sessionSegments(base, scope.integration, identifierHash(scope.sessionId)),
    CAPTURE_TURNS_DIRECTORY,
    identifierHash(scope.turnId),
    CAPTURE_EVENTS_DIRECTORY,
  ];
}

export function sessionsDirectory(root: string, integration: string): string {
  return join(
    captureDirectory(root),
    CAPTURE_INTEGRATIONS_DIRECTORY,
    integration,
    CAPTURE_SESSIONS_DIRECTORY,
  );
}

export function turnsDirectory(root: string, integration: string, sessionHash: string): string {
  return join(sessionsDirectory(root, integration), sessionHash, CAPTURE_TURNS_DIRECTORY);
}

export function eventsDirectory(turns: string, turnHash: string): string {
  return join(turns, turnHash, CAPTURE_EVENTS_DIRECTORY);
}

export function eventPath(root: string, scope: CaptureScope): string {
  return join(
    resolve(root),
    ...eventSegments(CAPTURE_DIRECTORY, scope),
    `${identifierHash(scope.eventId)}.json`,
  );
}
