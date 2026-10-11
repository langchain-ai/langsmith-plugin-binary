export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface CaptureInput {
    integration: string;
    sessionId: string;
    turnId: string;
    eventId: string;
    runId: string;
    destinationFingerprint: string;
    eventKind: string;
    normalizedPayload: JsonValue;
    turnEvidence: JsonValue;
    metadataProvenance: JsonValue;
}
export interface StoredCapture extends CaptureInput {
    version: number;
    capturedAtMs: number;
    compaction?: CompactedCapturePayload;
    sourceSnapshotCleanup?: SourceSnapshotCleanup;
}
export interface SourceSnapshotCleanup {
    version: 1;
    originalContentDigest: string;
}
export type CompactedFieldDigest = {
    state: "preserve";
} | {
    state: "absent";
} | {
    state: "value";
    digest: string;
};
export interface CompactedCapturePayload {
    version: 1;
    originalContentDigest: string;
    fields: {
        inputs: CompactedFieldDigest;
        outputs: CompactedFieldDigest;
    };
}
export interface CaptureCompactionFields {
    inputs: CompactedFieldDigest;
    outputs: CompactedFieldDigest;
}
export interface CaptureCompactionPayload {
    value: JsonValue;
    fields: CaptureCompactionFields;
}
export type StorageFailure = {
    status: "failed";
    code: string;
    message: string;
};
export interface CaptureScope {
    integration: string;
    sessionId: string;
    turnId: string;
    eventId: string;
}
export type CaptureWriteResult = {
    status: "published";
    record: StoredCapture;
} | {
    status: "duplicate";
    record: StoredCapture;
} | {
    status: "conflict";
} | StorageFailure;
export type CaptureCompactionResult = {
    status: "compacted";
    record: StoredCapture;
} | {
    status: "already-compacted";
    record: StoredCapture;
} | {
    status: "changed";
} | {
    status: "missing-capture";
} | StorageFailure;
export type ReconstructionJobCleanupResult = {
    status: "compacted";
    record: StoredCapture;
} | {
    status: "already-compacted";
    record: StoredCapture;
} | {
    status: "unchanged";
} | {
    status: "not-delivered";
} | {
    status: "changed";
} | {
    status: "missing-capture";
} | StorageFailure;
export interface OutcomeInput extends CaptureScope {
    destination: string;
    outcome: "delivered" | "dropped";
    reason?: string;
}
export interface OutcomeReceipt extends CaptureScope {
    version: number;
    destination: string;
    outcome: "delivered" | "dropped";
    reason?: string;
    recordedAt: string;
}
export type OutcomeWriteResult = {
    status: "recorded";
    receipt: OutcomeReceipt;
} | {
    status: "duplicate";
    receipt: OutcomeReceipt;
} | {
    status: "conflict";
} | {
    status: "missing-capture";
} | StorageFailure;
export type OutcomeReadResult = {
    status: "pending";
} | {
    status: "settled";
    receipt: OutcomeReceipt;
} | {
    status: "missing-capture";
} | StorageFailure;
export interface CaptureStore {
    capture(input: CaptureInput): Promise<CaptureWriteResult>;
    compact(scope: CaptureScope, expected: StoredCapture): Promise<CaptureCompactionResult>;
    compactReconstructionJob(scope: CaptureScope, expected: StoredCapture, destination: string): Promise<ReconstructionJobCleanupResult>;
    read(scope: CaptureScope): Promise<StoredCapture | undefined>;
    recordOutcome(input: OutcomeInput): Promise<OutcomeWriteResult>;
    readOutcome(scope: CaptureScope, destination: string): Promise<OutcomeReadResult>;
}
//# sourceMappingURL=models.d.ts.map