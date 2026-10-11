import type { StoredCapture } from "../../storage/capture/models.js";
import type { ProjectedCapture, SettleCapturedTurnsOptions, TurnSettlementResult } from "./models.js";
export declare function settleOneTurn(turnId: string, events: ProjectedCapture[], generated: StoredCapture[], allByRunId: ReadonlyMap<string, ProjectedCapture[]>, options: SettleCapturedTurnsOptions): Promise<TurnSettlementResult>;
//# sourceMappingURL=settle-turn.d.ts.map