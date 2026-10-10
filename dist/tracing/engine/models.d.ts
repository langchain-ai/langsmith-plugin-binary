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
    backgroundRecovery?: TracingEngineBackgroundRecoveryOptions;
}
export type TracingEngineSessionCallbacks = Omit<TracingEngineSessionOptions, "sessionId" | "backgroundRecovery">;
export interface TracingEngineRecoveryOptions {
    optionsForSession: (sessionId: string) => TracingEngineSessionCallbacks | Promise<TracingEngineSessionCallbacks>;
    minimumForeignAgeMs?: number;
    now?: number;
    excludeCurrentSession?: boolean;
}
export type TracingEngineRecoveryScopeGuard = () => Promise<boolean>;
export interface TracingEngineBackgroundRecoveryOptions {
    optionsForSession: TracingEngineRecoveryOptions["optionsForSession"];
    onReport: (result: TracingEngineBackgroundRecoveryResult) => void | Promise<void>;
    minimumForeignAgeMs?: number;
    cooldownMs?: number;
}
export type TracingEngineBackgroundRecoveryResult = {
    status: "completed";
    report: TracingEngineRecoveryReport;
    retryAtMs: number;
} | {
    status: "partial";
    report: TracingEngineRecoveryReport;
    retryAtMs: number;
    retryable: true;
} | {
    status: "cooldown";
    retryAtMs: number;
} | {
    status: "scope-mismatch";
} | {
    status: "failed";
    message: string;
    retryable: true;
    retryAtMs?: number;
};
export interface TracingEngineBackgroundRecoveryMarker {
    version: typeof import("./constants.js").TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_VERSION;
    retryAtMs: number;
}
export interface TracingEngineBackgroundRecoveryPaths {
    directory: string;
    lock: string;
    marker: string;
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