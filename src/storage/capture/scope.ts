import type { CaptureScope } from "./models.js";

export function scopeOf(value: CaptureScope): CaptureScope {
  return {
    integration: value.integration,
    sessionId: value.sessionId,
    turnId: value.turnId,
    eventId: value.eventId,
  };
}

export function scopeKey(scope: CaptureScope): string {
  return JSON.stringify([scope.integration, scope.sessionId, scope.turnId, scope.eventId]);
}
