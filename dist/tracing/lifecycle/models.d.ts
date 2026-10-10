import type { CodingAgentIntegration, CodingAgentMetadataOptions } from "../../metadata/index.js";
import type { CaptureDependency, CaptureWriteResult } from "../../storage/capture/models.js";
import type { DeliveryDrainResult, DeliveryPolicy } from "../delivery/index.js";
import type { PreparedRunPatchSubmission, PreparedRunPostSubmission } from "../upload/models.js";
import type { LangSmithUploadWriterOptions, PreparedRunSubmission } from "../upload/index.js";
export type ProjectedPayload = Omit<PreparedRunPostSubmission, "metadata"> | Omit<PreparedRunPatchSubmission, "metadata">;
export interface ProjectedSubmission {
    payload: ProjectedPayload;
    metadata: CodingAgentMetadataOptions;
}
export type LifecycleTurnClosureState = "open" | "provisional" | "authoritative";
export interface LifecycleTurnEvidence {
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
}
export type LifecycleCaptureResult = CaptureWriteResult | {
    status: "deferred";
    reason: "missing-thread-identity";
};
export interface LifecycleDrainInput {
    now?: number;
}
export interface LifecycleBridge {
    readonly accountFingerprint: string;
    capture(input: LifecycleCaptureInput): Promise<LifecycleCaptureResult>;
    drain(input?: LifecycleDrainInput): Promise<DeliveryDrainResult>;
}
//# sourceMappingURL=models.d.ts.map