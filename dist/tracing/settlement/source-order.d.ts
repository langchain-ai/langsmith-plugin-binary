import type { CaptureScope, StoredCapture } from "../../storage/capture/models.js";
import type { TurnSettlementReport } from "./models.js";
export declare function uniqueScopes(scopes: readonly CaptureScope[]): CaptureScope[];
export declare function captureScope(record: StoredCapture): CaptureScope;
export declare function captureScopeKey(scope: CaptureScope): string;
export declare function compareScopes(left: CaptureScope, right: CaptureScope): number;
export declare function orderSourceCaptures(records: readonly StoredCapture[]): StoredCapture[];
export declare function groupByTurn(records: readonly StoredCapture[]): Map<string, StoredCapture[]>;
export declare function report(turnId: string, status: TurnSettlementReport["status"], reason: NonNullable<TurnSettlementReport["reason"]>, runIds?: string[], destinations?: string[]): TurnSettlementReport;
//# sourceMappingURL=source-order.d.ts.map