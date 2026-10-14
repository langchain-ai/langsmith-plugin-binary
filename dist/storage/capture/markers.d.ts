import type { CaptureOutcome, CaptureSettledTurn, CaptureScope, StoredCapture } from "./models.js";
export declare function writeOutcomeMarker(root: string, scope: CaptureScope, record: StoredCapture): Promise<void>;
export declare function writeTurnMarker(root: string, records: readonly StoredCapture[], settled: CaptureSettledTurn | undefined): Promise<void>;
export declare function readSettledTurn(root: string, scope: Pick<CaptureScope, "integration" | "sessionId" | "turnId">): Promise<CaptureSettledTurn | undefined>;
export declare function readMarkerOutcome(root: string, scope: CaptureScope, destination: string): Promise<CaptureOutcome | undefined>;
export declare function readDroppedRunIds(root: string, scope: Pick<CaptureScope, "integration" | "sessionId" | "turnId">): Promise<Set<string>>;
export declare function forgetTurnMarkers(root: string, scope: CaptureScope): Promise<void>;
export declare function removeStaleMarkers(root: string, integration: string, modifiedBeforeMs: number): Promise<number>;
//# sourceMappingURL=markers.d.ts.map