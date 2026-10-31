import type { CodingAgentIntegration } from "../../metadata/models.js";
import type { SavedCaptureResult } from "../capture-wake-models.js";
import type {
  CaptureStore,
  CaptureWriteResult,
  EnumeratedCapture,
} from "../../storage/capture/models.js";
import type {
  BackgroundWorker,
  BackgroundWorkerOptions,
  BackgroundWorkerRunResult,
  BackgroundWorkerScope,
  BackgroundWorkerWakeResult,
} from "../background-worker/models.js";
import type { DeliveryDestination } from "../delivery/models.js";
import type {
  LifecycleBridge,
  LifecycleCaptureInput,
  LifecycleCaptureResult,
} from "../lifecycle/models.js";
import type {
  ReconstructionCallback,
  ReconstructionJobInput,
  ReconstructionWorker,
} from "../reconstruction/models.js";
import type { LangSmithUploadWriter, LangSmithUploadWriterOptions } from "../upload/models.js";

export interface TracingEngineOptions {
  storageRoot: string;
  integration: CodingAgentIntegration;
  writer: LangSmithUploadWriterOptions;
}

export interface TracingEngineSessionOptions {
  sessionId: string;
  reconstruct: ReconstructionCallback;
  scheduleWake: BackgroundWorkerOptions["launchWorker"];
  resolveScope: TracingEngineScopeResolver;
  startupWaitMs?: number;
  backgroundRecovery?: TracingEngineBackgroundRecoveryOptions;
}

export type TracingEngineSessionCallbacks = Omit<
  TracingEngineSessionOptions,
  "sessionId" | "backgroundRecovery"
>;

export interface TracingEngineRecoveryOptions {
  optionsForSession: (
    sessionId: string,
  ) => TracingEngineSessionCallbacks | Promise<TracingEngineSessionCallbacks>;
  minimumForeignAgeMs?: number;
  now?: number;
  excludeCurrentSession?: boolean;
}

export type TracingEngineRecoveryScopeGuard = () => Promise<boolean>;

export interface TracingEngineBackgroundRecoveryOptions {
  optionsForSession: TracingEngineRecoveryOptions["optionsForSession"];
  onReport: (result: TracingEngineBackgroundRecoveryResult) => void | Promise<void>;
  minimumForeignAgeMs?: number;
}

export type TracingEngineBackgroundRecoveryResult =
  | { status: "completed"; report: TracingEngineRecoveryReport }
  | { status: "partial"; report: TracingEngineRecoveryReport; retryable: true }
  | { status: "scope-mismatch" }
  | { status: "failed"; message: string; retryable: true };

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
  queueReconstruction(input: ReconstructionJobInput): Promise<CaptureWriteResult>;
  readSavedReconstructionWake(
    error: unknown,
    input: ReconstructionJobInput,
  ): Promise<SavedCaptureResult | undefined>;
  wake(): Promise<BackgroundWorkerWakeResult>;
  drain(): Promise<BackgroundWorkerRunResult>;
  recoverSessions(options: TracingEngineRecoveryOptions): Promise<TracingEngineRecoveryReport>;
}

export interface TracingEngine {
  forSession(options: TracingEngineSessionOptions): TracingEngineSession;
}

export type TracingEngineScope = BackgroundWorkerScope;
export type TracingEngineScopeResolver = (
  expected: TracingEngineScope,
) => TracingEngineScope | Promise<TracingEngineScope>;

export interface RetryState {
  pending: number;
  nextRetryAtMs?: number;
}

export type RetryWaitResult = { status: "busy" } | ({ status: "drained" } & RetryState);

export interface TracingEngineRecoveryIndex {
  lifecycleStore: CaptureStore;
  writer: LangSmithUploadWriter;
  destinationIds: string[];
  lifecycleBySession: ReadonlyMap<string, EnumeratedCapture[]>;
  reconstructionBySession: ReadonlyMap<string, EnumeratedCapture[]>;
  savedScopes: ReadonlySet<string>;
  waitingForOtherSetting: number;
}

export interface TracingEngineSessionAssessment {
  hasPendingWork: boolean;
  hasUnsettledTurn: boolean;
  lastActivityAtMs: number;
  oldestPendingAtMs: number;
}

export interface TracingEngineSessionState {
  backgroundWorker?: BackgroundWorker;
  droppedWork: boolean;
}

export interface TracingEngineSessionContext {
  config: TracingEngineOptions;
  session: TracingEngineSessionOptions;
  scope: BackgroundWorkerScope;
  lifecycleBridge: LifecycleBridge;
  reconstructionWorker: ReconstructionWorker;
  state: TracingEngineSessionState;
}

export interface RecoveryStep {
  sessionId: string;
  scheduled?: TracingEngineRecoverySchedule | undefined;
  failed?: TracingEngineRecoveryFailure | undefined;
}

export interface RecoveryForeignCandidate {
  sessionId: string;
  oldestPendingAtMs: number;
}

export interface RecoveryPlanOptions {
  runtime: TracingEngineRecoveryRuntime;
  index: TracingEngineRecoveryIndex;
  request: TracingEngineRecoveryOptions;
  now: number;
  minimumForeignAgeMs: number;
  wakeForeign: (sessionId: string) => Promise<TracingEngineRecoverySchedule | undefined>;
}

export type ScopeVerdict =
  | { kind: "ok" }
  | { kind: "mismatch" }
  | { kind: "failed"; error: unknown };

export interface HookOutput {
  name: string;
  output: string;
}
