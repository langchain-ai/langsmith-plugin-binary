import { canonicalJson } from "../../storage/capture/utils/serialization.js";
import { refreshSettlementProgress, settleCapturedTurns } from "../settlement/pass.js";
export async function hasUnsettledRecoverySettlement(options) {
    const missingSettlementCapture = Symbol();
    try {
        const work = await settleCapturedTurns({
            captures: options.captures,
            integration: options.integration,
            sessionId: options.sessionId,
            destinationFingerprint: options.destinationFingerprint,
            destinations: options.destinations,
            capture: async (input) => {
                const scope = {
                    integration: options.integration,
                    sessionId: options.sessionId,
                    turnId: input.turnId,
                    eventId: input.eventId,
                };
                const existing = await options.store.read(scope);
                if (existing === undefined)
                    throw missingSettlementCapture;
                const existingContent = Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "capturedAtMs"));
                const plannedContent = {
                    version: existing.version,
                    integration: options.integration,
                    sessionId: options.sessionId,
                    ...input,
                };
                if (canonicalJson(existingContent) !== canonicalJson(plannedContent))
                    throw new Error("Recovery settlement capture conflicts with the current source state");
                return { status: "duplicate", record: existing };
            },
            readOutcome: (scope, destination) => options.store.readOutcome(scope, destination),
        });
        const progress = await refreshSettlementProgress(work, options.destinations, (scope, destination) => options.store.readOutcome(scope, destination));
        return progress.turns.some((turn) => turn.status !== "settled");
    }
    catch (error) {
        if (error === missingSettlementCapture)
            return true;
        throw error;
    }
}
//# sourceMappingURL=recovery-settlement.js.map