import type { CodingAgentIntegration } from "../../metadata/models.js";
import type { CaptureWriteResult } from "../../storage/capture/models.js";
import type {
  BackgroundWorkerOptions,
  BackgroundWorkerRetryPolicy,
  BackgroundWorkerRunResult,
  BackgroundWorkerScope,
  BackgroundWorkerWakeResult,
} from "../background-worker/models.js";
import type { DeliveryPolicy } from "../delivery/models.js";
import type { LifecycleCaptureInput, LifecycleCaptureResult } from "../lifecycle/models.js";
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

export interface TracingEngineSession {
  capture(input: LifecycleCaptureInput): Promise<LifecycleCaptureResult>;
  queueReconstruction(input: ReconstructionJobInput): Promise<CaptureWriteResult>;
  wake(): Promise<BackgroundWorkerWakeResult>;
  drain(): Promise<BackgroundWorkerRunResult>;
}

export interface TracingEngine {
  forSession(options: TracingEngineSessionOptions): TracingEngineSession;
}

export type TracingEngineScope = BackgroundWorkerScope;
export type TracingEngineScopeResolver = (
  expected: TracingEngineScope,
) => TracingEngineScope | Promise<TracingEngineScope>;
