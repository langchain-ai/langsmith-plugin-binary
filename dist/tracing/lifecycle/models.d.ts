import type { CodingAgentIntegration, CodingAgentMetadataOptions } from "../../metadata/index.js";
import type { CaptureDependency, CaptureScope, CaptureSettledTurn, CaptureStore, CaptureWriteResult, EnumeratedCapture, OutcomeReadResult, StoredCapture } from "../../storage/capture/models.js";
import type { DeliveryCoordinator, DeliveryDestination, DeliveryDrainResult, DeliveryPolicy } from "../delivery/models.js";
import type { LangSmithUploadWriter, PreparedRunPatchSubmission, PreparedRunPostSubmission, RedactedRunField } from "../upload/models.js";
import type { LangSmithUploadWriterOptions, PreparedRunSubmission } from "../upload/index.js";
import type { TurnSettlementReport, TurnSettlementWork } from "../settlement/models.js";
import type { CodingAgentPrivacyStatus } from "../../privacy/index.js";
export type ProjectedPayload = Omit<PreparedRunPostSubmission, "metadata"> | Omit<PreparedRunPatchSubmission, "metadata">;
export interface ProjectedSubmission {
    payload: ProjectedPayload;
    metadata: CodingAgentMetadataOptions;
    privacyStatus: CodingAgentPrivacyStatus;
}
export interface RemoveSettledTurnsOptions {
    integration: CodingAgentIntegration;
    sessionId: string;
    destinationFingerprint: string;
    store: CaptureStore;
    destinations: readonly DeliveryDestination[];
    settledTurnIds: readonly string[];
    settledTurns?: ReadonlyMap<string, CaptureSettledTurn>;
    knownScopes: readonly CaptureScope[];
}
type LifecycleTurnClosureState = "open" | "provisional" | "authoritative";
export interface LifecycleTurnEvidence {
    rootRunId?: string | undefined;
    childRunIds: string[];
    closureState: LifecycleTurnClosureState;
}
export interface RunIdentity {
    id: string;
    start_time: number | string;
    parent_run_id?: string;
    trace_id: string;
    dotted_order: string;
}
export interface RunParentIdentity {
    id: string;
    parent_run_id?: string;
    trace_id: string;
    dotted_order: string;
    start_time?: number | string;
}
export interface RunIdentityInput {
    id: string;
    start_time: number | string;
    parent?: RunParentIdentity;
}
export interface DottedOrderSegment {
    timestamp: string;
    runId: string;
}
export type SubmissionProjectionResult = {
    status: "ready";
    value: ProjectedSubmission;
} | {
    status: "deferred";
};
export interface LifecycleBridgeOptions {
    storageRoot: string;
    integration: CodingAgentIntegration;
    sessionId: string;
    writer: LangSmithUploadWriterOptions;
    policy?: Partial<DeliveryPolicy>;
    wake?: () => unknown | Promise<unknown>;
}
export interface LifecycleCaptureInput {
    turnId: string;
    eventId: string;
    submission: PreparedRunSubmission;
    turnEvidence: LifecycleTurnEvidence;
    dependencies?: CaptureDependency[];
    sourceAgeStartedAtMs?: number;
}
export interface LifecycleEndTimeWithholdingInput {
    record: StoredCapture;
    submission: PreparedRunSubmission;
    sourceSnapshot: readonly StoredCapture[];
    sourceByScope: ReadonlyMap<string, StoredCapture>;
    integration: CodingAgentIntegration;
    destinations: readonly DeliveryDestination[];
    readOutcome: (scope: CaptureScope, destination: string) => Promise<OutcomeReadResult>;
}
export type LifecycleCaptureResult = CaptureWriteResult | {
    status: "deferred";
    reason: "missing-thread-identity";
};
export interface LifecycleDrainInput {
    now?: number;
}
interface LifecycleSettlementProgress {
    captured: number;
    turns: TurnSettlementReport[];
}
export type LifecycleDrainResult = {
    status: "busy";
    settlement: LifecycleSettlementProgress;
} | (Extract<DeliveryDrainResult, {
    status: "drained";
}> & {
    settlement: LifecycleSettlementProgress;
});
export interface LifecycleBridge {
    readonly accountFingerprint: string;
    capture(input: LifecycleCaptureInput): Promise<LifecycleCaptureResult>;
    drain(input?: LifecycleDrainInput): Promise<LifecycleDrainResult>;
}
export interface LifecycleBridgeContext {
    integration: CodingAgentIntegration;
    sessionId: string;
    storageRoot: string;
    captureStore: CaptureStore;
    coordinator: DeliveryCoordinator;
    writer: LangSmithUploadWriter;
    policy: DeliveryPolicy;
    wake: LifecycleBridgeOptions["wake"];
}
export interface LifecycleCaptureRequest {
    record: Record<string, unknown>;
    turnId: string;
    eventId: string;
    sourceAgeStartedAtMs: number | undefined;
}
export interface SuppliedRunIdentity {
    startTime: boolean;
    traceId: boolean;
    dottedOrder: boolean;
}
export type LifecycleDrainedResult = Extract<DeliveryDrainResult, {
    status: "drained";
}>;
export interface LifecycleSettlementPass {
    captures: EnumeratedCapture[];
    work: TurnSettlementWork;
}
export interface ProjectionCommon {
    integration: CodingAgentIntegration;
    privacyMode: "full" | "metadata";
    redaction: {
        redactedFields?: readonly RedactedRunField[];
    };
}
export interface CapturedRunsSend {
    sourceSnapshot: StoredCapture[];
    sourceByScope: ReadonlyMap<string, StoredCapture>;
    records: readonly StoredCapture[];
    destination: DeliveryDestination;
    fingerprint: string;
}
export {};
//# sourceMappingURL=models.d.ts.map