export async function captureReadiness(scopes, destinations, readOutcome) {
    const pending = new Set();
    const dropped = new Set();
    for (const scope of scopes) {
        for (const destination of destinations) {
            const outcome = await readOutcome(scope, destination.id);
            if (outcome.status === "failed")
                throw new Error(`Could not read settlement receipt: ${outcome.code}`);
            if (outcome.status === "settled") {
                if (outcome.receipt.outcome === "dropped")
                    dropped.add(destination.id);
            }
            else {
                pending.add(destination.id);
            }
        }
    }
    return dropped.size > 0
        ? { status: "dropped", destinations: [...dropped].toSorted() }
        : pending.size > 0
            ? { status: "pending", destinations: [...pending].toSorted() }
            : { status: "delivered", destinations: [] };
}
//# sourceMappingURL=readiness.js.map