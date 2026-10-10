import type { CompactedCapturePayload, JsonValue, StoredCapture } from "./models.js";
export declare function captureContentDigest(record: StoredCapture): string;
export declare function compactCaptureRecord(record: StoredCapture, originalContentDigest: string): StoredCapture | undefined;
export declare function validateCompactionMarker(value: unknown, eventKind: string, normalizedPayload: JsonValue): CompactedCapturePayload;
//# sourceMappingURL=compaction.d.ts.map