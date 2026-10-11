import type { CaptureScope } from "../../storage/capture/models.js";
import type { SettleCapturedTurnsOptions, SettlementSourceReadiness } from "./models.js";
export declare function captureReadiness(scopes: readonly CaptureScope[], destinations: SettleCapturedTurnsOptions["destinations"], readOutcome: SettleCapturedTurnsOptions["readOutcome"]): Promise<SettlementSourceReadiness>;
//# sourceMappingURL=readiness.d.ts.map