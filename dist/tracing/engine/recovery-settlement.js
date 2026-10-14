import { canonicalJson } from "../../storage/capture/utils/serialization.js";
import { refreshSettlementProgress, settleCapturedTurns } from "../settlement/pass.js";
import { TRACING_ENGINE_RECOVERY_SETTLEMENT_CONFLICT_MESSAGE } from "./constants.js";
import { MissingSettlementCaptureError } from "./errors.js";
export async function hasUnsettledRecoverySettlement(options) {
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
                    throw new MissingSettlementCaptureError();
                const existingContent = Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "capturedAtMs" && key !== "delivery"));
                const plannedContent = {
                    version: existing.version,
                    integration: options.integration,
                    sessionId: options.sessionId,
                    ...input,
                };
                if (canonicalJson(existingContent) !== canonicalJson(plannedContent))
                    throw new Error(TRACING_ENGINE_RECOVERY_SETTLEMENT_CONFLICT_MESSAGE);
                return { status: "duplicate", record: existing };
            },
            readOutcome: (scope, destination) => options.store.readOutcome(scope, destination),
            droppedRunIds: (turnId) => options.store.readDroppedRunIds(options.integration, options.sessionId, turnId),
            settledTurn: (turnId) => options.store.readSettledTurn(options.integration, options.sessionId, turnId),
        });
        const progress = await refreshSettlementProgress(work, options.destinations, (scope, destination) => options.store.readOutcome(scope, destination));
        return progress.turns.some((turn) => turn.status === "pending");
    }
    catch (error) {
        if (error instanceof MissingSettlementCaptureError)
            return true;
        throw error;
    }
}
//# sourceMappingURL=recovery-settlement.js.map