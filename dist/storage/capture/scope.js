export function scopeOf(value) {
    return {
        integration: value.integration,
        sessionId: value.sessionId,
        turnId: value.turnId,
        eventId: value.eventId,
    };
}
export function scopeKey(scope) {
    return JSON.stringify([scope.integration, scope.sessionId, scope.turnId, scope.eventId]);
}
//# sourceMappingURL=scope.js.map