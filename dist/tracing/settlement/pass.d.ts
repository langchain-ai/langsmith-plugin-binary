import type { CaptureScope, OutcomeReadResult } from "../../storage/capture/models.js";
import type { SettleCapturedTurnsOptions, TurnSettlementProgress, TurnSettlementWork } from "./models.js";
export declare function settleCapturedTurns(options: SettleCapturedTurnsOptions): Promise<TurnSettlementWork>;
export declare function refreshSettlementProgress(work: TurnSettlementWork, destinations: SettleCapturedTurnsOptions["destinations"], readOutcome: (scope: CaptureScope, destination: string) => Promise<OutcomeReadResult>): Promise<TurnSettlementProgress>;
//# sourceMappingURL=pass.d.ts.map