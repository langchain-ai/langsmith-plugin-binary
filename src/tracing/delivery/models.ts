import type {
  CaptureInput,
  CaptureScope,
  CaptureWriteResult,
  EnumeratedCapture,
  OutcomeInput,
  OutcomeReadResult,
  OutcomeReceipt,
  StoredCapture,
} from "../../storage/capture/models.js";

export type DeliveryCaptureInput = Omit<CaptureInput, "integration" | "sessionId">;

export interface DeliveryPolicy {
  maxAttempts: number;
  maxAgeMs: number;
  maxEntries: number;
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

export interface DeliveryWriter {
  readonly accountFingerprint: string;
  readonly destinations: readonly DeliveryDestination[];
  readonly send: DeliveryTransport;
}

export type DeliveryTransport = (
  record: StoredCapture,
  destination: DeliveryDestination,
  accountFingerprint: string,
) => Promise<void>;

export interface DrainOptions {
  writer: DeliveryWriter;
  now?: number;
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

export type DeliveryDrainResult =
  | { status: "busy" }
  | (DeliveryDrainCounts & {
      status: "drained";
      pending: number;
      accountMismatch: number;
    });

export interface DeliveryAttempt extends CaptureScope {
  version: number;
  destination: string;
  attempt: number;
  startedAt: string;
}

export interface DeliveryAttemptStore {
  count(scope: CaptureScope, destination: string): Promise<number>;
  record(
    scope: CaptureScope,
    destination: string,
    attempt: number,
    startedAt: string,
  ): Promise<void>;
}

export interface DeliveryDrainCache {
  read(scope: CaptureScope): Promise<StoredCapture | undefined>;
  readOutcome(scope: CaptureScope, destination: string): Promise<OutcomeReadResult>;
  recordOutcome(input: OutcomeInput): Promise<OutcomeReceipt>;
  rememberCapture(record: StoredCapture): void;
}

export interface DeliveryPendingCandidate {
  entry: EnumeratedCapture;
  scope: CaptureScope;
  pending: DeliveryDestination[];
}

export type DeliveryDependencyState = "ready" | "pending" | "dropped";
