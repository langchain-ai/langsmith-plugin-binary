import type { CaptureOutcome, CaptureSettledTurn, CaptureScope, CaptureStorageRoot, StoredCapture } from "./models.js";
export declare function writeOutcomeMarker(root: CaptureStorageRoot, scope: CaptureScope, record: StoredCapture): Promise<void>;
export declare function writeTurnMarker(root: CaptureStorageRoot, records: readonly StoredCapture[], settled: CaptureSettledTurn | undefined): Promise<void>;
export declare function readSettledTurn(root: CaptureStorageRoot, scope: Pick<CaptureScope, "integration" | "sessionId" | "turnId">): Promise<CaptureSettledTurn | undefined>;
export declare function readMarkerOutcome(root: CaptureStorageRoot, scope: CaptureScope, destination: string): Promise<CaptureOutcome | undefined>;
export declare function readDroppedRunIds(root: CaptureStorageRoot, scope: Pick<CaptureScope, "integration" | "sessionId" | "turnId">): Promise<Set<string>>;
export declare function forgetTurnMarkers(root: CaptureStorageRoot, scope: CaptureScope): Promise<void>;
export declare function removeStaleMarkers(root: CaptureStorageRoot, integration: string, modifiedBeforeMs: number): Promise<number>;
//# sourceMappingURL=markers.d.ts.map