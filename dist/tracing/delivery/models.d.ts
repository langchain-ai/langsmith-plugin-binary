import type { CaptureInput, CaptureScope, CaptureStore, CaptureWriteResult, EnumeratedCapture, OutcomeInput, OutcomeReadResult, OutcomeReceipt, StoredCapture } from "../../storage/capture/models.js";
export type DeliveryCaptureInput = Omit<CaptureInput, "integration" | "sessionId">;
export interface DeliveryPolicy {
    maxAgeMs: number;
    maxEntries: number;
    retryBaseMs: number;
    quickRetryMs: number;
}
export interface DeliveryCoordinatorOptions {
    storageRoot: string;
    integration: string;
    sessionId: string;
    policy?: Partial<DeliveryPolicy>;
}
export interface DeliveryDestination {
    readonly id: string;
}
export interface DeliveryBatchLimits {
    readonly maxRecords: number;
    readonly maxBytes: number;
}
export interface DeliveryWriter {
    readonly accountFingerprint: string;
    readonly destinations: readonly DeliveryDestination[];
    readonly sendBatch: (records: readonly StoredCapture[], destination: DeliveryDestination, accountFingerprint: string) => Promise<void>;
    readonly batchLimits: DeliveryBatchLimits;
}
export interface DrainOptions {
    writer: DeliveryWriter;
    attempted?: Set<string>;
}
export interface DeliveryCoordinator {
    capture(input: DeliveryCaptureInput): Promise<CaptureWriteResult>;
    drain(options: DrainOptions): Promise<DeliveryDrainResult>;
}
export interface DeliveryDrainCounts {
    delivered: number;
    dropped: number;
    failed: number;
}
export type DeliveryDrainResult = {
    status: "busy";
} | (DeliveryDrainCounts & {
    status: "drained";
    pending: number;
    nextRetryAtMs?: number;
    accountMismatch: number;
});
export interface DeliveryDrainCache {
    read(scope: CaptureScope): Promise<StoredCapture | undefined>;
    readOutcome(scope: CaptureScope, destination: string): Promise<OutcomeReadResult>;
    recordOutcome(input: OutcomeInput): Promise<OutcomeReceipt>;
    rememberCapture(record: StoredCapture): void;
    readonly dependentDrops: Map<string, Set<string>>;
}
export interface DeliveryBatch {
    candidates: DeliveryPendingCandidate[];
    scopes: Set<string>;
    runIds: Set<string>;
    bytes: number;
}
export interface DeliveryDestinationResult {
    delivered: number;
    dropped: number;
    failed: number;
    progressed: boolean;
}
export interface DeliveryDrainPassContext {
    captureStore: CaptureStore;
    drainCache: DeliveryDrainCache;
    policy: DeliveryPolicy;
    request: DrainOptions;
    attempted: Set<string>;
    sendable: readonly DeliveryPendingCandidate[];
}
export interface DeliveryPendingCandidate {
    entry: EnumeratedCapture;
    scope: CaptureScope;
    pending: DeliveryDestination[];
}
export interface DeliveryPendingCount {
    count: number;
    nextRetryAtMs?: number;
}
export type DeliveryDependencyState = "ready" | "pending" | "dropped";
export interface DeliveryFailure {
    retryable?: boolean;
    status?: number;
}
export interface DeliveryDroppedWork {
    reason: string;
    status?: number | undefined;
}
export interface DeliveryCoordinatorContext {
    integration: string;
    sessionId: string;
    storageRoot: string;
    policy: DeliveryPolicy;
    captureStore: CaptureStore;
    mismatchWarned: {
        value: boolean;
    };
}
//# sourceMappingURL=models.d.ts.map