export async function matchesScope(resolveScope, expected) {
    const actual = await resolveScope();
    return (actual.integration === expected.integration &&
        actual.sessionId === expected.sessionId &&
        actual.accountFingerprint === expected.accountFingerprint);
}
//# sourceMappingURL=scope.js.map