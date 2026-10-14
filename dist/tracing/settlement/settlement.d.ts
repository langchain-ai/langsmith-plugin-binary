import type { Attribution, RecordedRun, TurnRecord } from "./models.js";
export declare function attributionOf(metadata: Record<string, unknown> | undefined): Attribution;
export declare const namesARepository: (carried: Attribution) => boolean;
export declare function turnAttribution(record: TurnRecord): Attribution | undefined;
export declare function metadataAfterFill(run: RecordedRun, filled: Attribution): Record<string, unknown> | undefined;
export declare function settledTurnMetadata(base: Record<string, unknown> | undefined, record: TurnRecord | undefined): Record<string, unknown> | undefined;
//# sourceMappingURL=settlement.d.ts.map