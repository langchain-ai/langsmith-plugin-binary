import type { CodingAgentIntegration, CodingAgentMetadataMode } from "../../metadata/index.js";
import type { CaptureDependency, CaptureScope, CaptureStore, CaptureWriteResult, EnumeratedCapture } from "../../storage/capture/models.js";
import type { DeliveryPolicy } from "../delivery/models.js";
import type { SavedCaptureResult } from "../capture-wake-models.js";
import type { LifecycleBridge, LifecycleTurnEvidence } from "../lifecycle/models.js";
import type { PreparedRunSubmission } from "../upload/models.js";
import type { RECONSTRUCTION_DEFERRED_REASON } from "./constants.js";
export interface ReconstructionJobInput {
    readonly turnId: string;
    readonly eventId: string;
    readonly sourceRefs: readonly string[];
    readonly privacyMode: CodingAgentMetadataMode;
    readonly turnEvidence: ReconstructionTurnEvidence;
    readonly sourceSnapshots?: readonly ReconstructionSourceSnapshot[];
    readonly sourceAgeStartedAtMs?: number;
}
export interface ReconstructionJob extends ReconstructionJobInput {
    readonly integration: CodingAgentIntegration;
    readonly sessionId: string;
    readonly accountFingerprint: string;
}
export interface ReconstructionTurnEvidence {
    readonly rootRunId?: string;
    readonly childRunIds: readonly string[];
    readonly closureState: LifecycleTurnEvidence["closureState"];
}
export interface ReconstructionToolOrigin {
    readonly path?: string;
    readonly cwd?: string;
    readonly namedAPath: boolean;
}
export interface ReconstructionAttributionContext {
    readonly toolOrigin: ReconstructionToolOrigin;
    readonly pinnedRepositoryKeys?: readonly string[];
}
export interface ReconstructionSourceSnapshot {
    readonly sourceRef: string;
    readonly submission: PreparedRunSubmission;
    readonly sourceAgeStartedAtMs: number;
    readonly attributionContext?: ReconstructionAttributionContext;
}
export interface ReconstructionOutput {
    eventId: string;
    submission: PreparedRunSubmission;
    turnEvidence?: ReconstructionTurnEvidence;
    dependencies?: CaptureDependency[];
    sourceRef?: string;
}
export type ReconstructionResult = {
    status: "ready";
    outputs: readonly ReconstructionOutput[];
} | {
    status: "deferred";
    reason: typeof RECONSTRUCTION_DEFERRED_REASON;
};
export type ReconstructionCallback = (job: ReconstructionJob) => Promise<ReconstructionResult>;
export interface ReconstructionWorkerOptions {
    storageRoot: string;
    integration: CodingAgentIntegration;
    sessionId: string;
    bridge: Pick<LifecycleBridge, "accountFingerprint" | "capture">;
    reconstruct: ReconstructionCallback;
    policy?: Partial<DeliveryPolicy>;
}
export interface ReconstructionDrainOptions {
    now?: number;
}
export interface ReconstructionWorker {
    enqueue(input: ReconstructionJobInput): Promise<CaptureWriteResult>;
    readSavedWake(error: unknown, input: ReconstructionJobInput): Promise<SavedCaptureResult | undefined>;
    drain(options?: ReconstructionDrainOptions): Promise<ReconstructionDrainResult>;
}
export interface ReconstructionDrainCounts {
    captured: number;
    deferred: number;
    failed: number;
    dropped: number;
}
export type ReconstructionDrainResult = {
    status: "busy";
} | (ReconstructionDrainCounts & {
    status: "drained";
    pending: number;
    nextRetryAtMs?: number;
    accountMismatch: number;
});
export interface ReconstructionValidatedOutput extends ReconstructionOutput {
    runId: string;
    sourceAgeStartedAtMs?: number;
}
export type ReconstructionJobProcessResult = "complete" | "deferred";
export type ReconstructionTerminalOutcome = "delivered" | "dropped";
export interface ReconstructionCandidate {
    entry: EnumeratedCapture;
    job: ReconstructionJob;
    scope: CaptureScope;
}
export interface StoredReconstructionMapping {
    recordVersion: 1;
    jobEventId: string;
    outputs: Array<{
        eventId: string;
        runId: string;
        dependencies?: CaptureDependency[];
        sourceRef?: string;
        turnEvidence?: ReconstructionTurnEvidence;
    }>;
}
export interface ReconstructionJobContext {
    store: CaptureStore;
    bridge: ReconstructionWorkerOptions["bridge"];
    reconstruct: ReconstructionCallback;
    retryBaseMs: number;
    counts: ReconstructionDrainCounts;
}
export type ReconstructionCaptureResult = "captured" | "deferred" | "failed";
export type ReconstructionInterpretation = Extract<ReconstructionResult, {
    status: "ready";
}> | "deferred" | "failed";
export interface ReconstructionWorkerContext {
    integration: CodingAgentIntegration;
    sessionId: string;
    accountFingerprint: string;
    policy: DeliveryPolicy;
    storageRoot: string;
    captureStore: CaptureStore;
    bridge: ReconstructionWorkerOptions["bridge"];
    reconstruct: ReconstructionCallback;
}
export interface ReconstructionPendingSummary {
    pending: number;
    nextRetryAtMs?: number;
    accountMismatch: number;
}
//# sourceMappingURL=models.d.ts.map