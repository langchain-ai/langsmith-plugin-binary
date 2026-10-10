import type { CodingAgentIntegration } from "../../metadata/models.js";
import type { CaptureStore, CaptureWriteResult, EnumeratedCapture } from "../../storage/capture/models.js";
import type { BackgroundWorkerOptions, BackgroundWorkerRetryPolicy, BackgroundWorkerRunResult, BackgroundWorkerScope, BackgroundWorkerWakeResult } from "../background-worker/models.js";
import type { DeliveryDestination, DeliveryPolicy } from "../delivery/models.js";
import type { LifecycleCaptureInput, LifecycleCaptureResult, LifecycleSnapshotCaptureInput } from "../lifecycle/models.js";
import type { ReconstructionCallback, ReconstructionJobInput } from "../reconstruction/models.js";
import type { LangSmithUploadWriterOptions } from "../upload/models.js";
export interface TracingEngineOptions {
    storageRoot: string;
    integration: CodingAgentIntegration;
    writer: LangSmithUploadWriterOptions;
    policy?: Partial<DeliveryPolicy>;
}
export interface TracingEngineSessionOptions {
    sessionId: string;
    reconstruct: ReconstructionCallback;
    scheduleWake: BackgroundWorkerOptions["launchWorker"];
    resolveScope: TracingEngineScopeResolver;
    startupWaitMs?: number;
    retryPolicy?: Partial<BackgroundWorkerRetryPolicy>;
}
export type TracingEngineSessionCallbacks = Omit<TracingEngineSessionOptions, "sessionId">;
export interface TracingEngineRecoveryOptions {
    optionsForSession: (sessionId: string) => TracingEngineSessionCallbacks | Promise<TracingEngineSessionCallbacks>;
    minimumForeignAgeMs?: number;
    now?: number;
}
export interface TracingEngineRecoverySettlementAssessmentOptions {
    captures: readonly EnumeratedCapture[];
    integration: CodingAgentIntegration;
    sessionId: string;
    destinationFingerprint: string;
    destinations: readonly DeliveryDestination[];
    store: CaptureStore;
}
export interface TracingEngineRecoveryRuntime {
    storageRoot: string;
    integration: CodingAgentIntegration;
    accountFingerprint: string;
    writer: LangSmithUploadWriterOptions;
    currentSessionId: string;
    wakeCurrent(): Promise<BackgroundWorkerWakeResult>;
    createSession(options: TracingEngineSessionOptions): TracingEngineSession;
}
export interface TracingEngineRecoverySchedule {
    sessionId: string;
    status: BackgroundWorkerWakeResult;
}
export interface TracingEngineRecoveryFailure {
    sessionId: string;
    message: string;
}
export interface TracingEngineRecoveryReport {
    scheduled: TracingEngineRecoverySchedule[];
    failed: TracingEngineRecoveryFailure[];
}
export interface TracingEngineSession {
    capture(input: LifecycleCaptureInput): Promise<LifecycleCaptureResult>;
    captureSnapshot(input: LifecycleSnapshotCaptureInput): Promise<LifecycleCaptureResult>;
    queueReconstruction(input: ReconstructionJobInput): Promise<CaptureWriteResult>;
    wake(): Promise<BackgroundWorkerWakeResult>;
    drain(): Promise<BackgroundWorkerRunResult>;
    recoverSessions(options: TracingEngineRecoveryOptions): Promise<TracingEngineRecoveryReport>;
}
export interface TracingEngine {
    forSession(options: TracingEngineSessionOptions): TracingEngineSession;
}
export type TracingEngineScope = BackgroundWorkerScope;
export type TracingEngineScopeResolver = (expected: TracingEngineScope) => TracingEngineScope | Promise<TracingEngineScope>;
//# sourceMappingURL=models.d.ts.map