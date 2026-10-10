import type { CaptureScope, CaptureWriteResult, EnumeratedCapture, OutcomeReadResult, StoredCapture } from "../../storage/capture/models.js";
import type { CodingAgentIntegration, CodingAgentMetadataOptions } from "../../metadata/models.js";
import type { DeliveryCaptureInput, DeliveryDestination } from "../delivery/models.js";
import type { ProjectedPayload } from "../lifecycle/models.js";
export type Attribution = Record<string, string>;
export interface RecordedRun {
    run_id: string;
    parent_run_id?: string | undefined;
    trace_id: string;
    dotted_order: string;
    name: string;
    run_type: string;
    project_name?: string | undefined;
    start_time?: string | undefined;
    end_time?: string | undefined;
    tracing: "full" | "metadata";
    open?: boolean | undefined;
    metadata: Record<string, unknown>;
}
export interface TurnRecord {
    path: string;
    origin: string;
    root?: RecordedRun | undefined;
    children: RecordedRun[];
    turnId?: string | undefined;
    closed: boolean;
    delivered: Set<string>;
    fixed: Set<string>;
}
export type TurnSettlementStatus = "settled" | "pending" | "deferred" | "blocked";
export type TurnSettlementReason = "no-attribution" | "no-change" | "open" | "provisional" | "missing-root" | "conflicting-root" | "missing-run" | "source-pending" | "source-dropped" | "settlement-pending" | "settlement-dropped";
export interface TurnSettlementReport {
    turnId: string;
    status: TurnSettlementStatus;
    reason?: TurnSettlementReason;
    runIds?: string[];
    destinations?: string[];
    patches: number;
}
export interface TurnSettlementProgress {
    captured: number;
    turns: TurnSettlementReport[];
}
export interface TurnSettlementPlannedPatch {
    turnId: string;
    runId: string;
    scope: CaptureScope;
}
export interface TurnSettlementWork {
    progress: TurnSettlementProgress;
    patches: TurnSettlementPlannedPatch[];
}
export interface TurnSettlementResult {
    report: TurnSettlementReport;
    patches: TurnSettlementPlannedPatch[];
    captured: number;
}
export type TurnEvidenceClosureState = "open" | "provisional" | "authoritative";
export interface TurnEvidenceSnapshot {
    rootRunId?: string;
    childRunIds: string[];
    closureState: TurnEvidenceClosureState;
    attributionReady: boolean;
}
export interface ProjectedCapture {
    record: StoredCapture;
    payload: ProjectedPayload;
    metadata: CodingAgentMetadataOptions;
    open: boolean;
    attributionReady: boolean;
}
export interface SettlementSourceReadiness {
    status: "delivered" | "pending" | "dropped";
    destinations: string[];
}
export interface SettleCapturedTurnsOptions {
    captures: readonly EnumeratedCapture[];
    integration: CodingAgentIntegration;
    sessionId: string;
    destinationFingerprint: string;
    destinations: readonly DeliveryDestination[];
    capture(input: DeliveryCaptureInput): Promise<CaptureWriteResult>;
    readOutcome(scope: CaptureScope, destination: string): Promise<OutcomeReadResult>;
}
//# sourceMappingURL=models.d.ts.map