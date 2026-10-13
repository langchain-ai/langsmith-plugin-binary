import type { CompactedCapturePayload, CaptureInput, JsonValue, SourceSnapshotCleanup, StoredCapture } from "./models.js";
export declare function captureContentDigest(record: CaptureInput | StoredCapture): string;
export declare function compactCaptureRecord(record: StoredCapture, originalContentDigest: string): StoredCapture | undefined;
export declare function compactReconstructionJobRecord(record: StoredCapture, originalContentDigest: string): StoredCapture | undefined;
export declare function validateSourceSnapshotCleanup(value: unknown, eventKind: string, normalizedPayload: JsonValue): SourceSnapshotCleanup;
export declare function validateCompactionMarker(value: unknown, eventKind: string, normalizedPayload: JsonValue): CompactedCapturePayload;
//# sourceMappingURL=compaction.d.ts.map