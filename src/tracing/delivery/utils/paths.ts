import { join } from "node:path";
import { identifierHash } from "../../../storage/capture/paths.js";
import type { CaptureScope } from "../../../storage/capture/models.js";
import { DELIVERY_DIRECTORY } from "../constants.js";

export function attemptSegments(scope: CaptureScope, destination: string): string[] {
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

export function attemptDirectory(root: string, scope: CaptureScope, destination: string): string {
  return join(root, ...attemptSegments(scope, destination));
}
