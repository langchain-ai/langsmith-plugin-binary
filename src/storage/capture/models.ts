export type CaptureDirectory = "turns" | "jobs";

export interface CaptureStorage {
  root: string;
  directory: CaptureDirectory;
}

export type CaptureStorageRoot = string | CaptureStorage;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CaptureScope {
  integration: string;
  sessionId: string;
  turnId: string;
  eventId: string;
}

export type CaptureDependency = CaptureScope;

export interface CaptureDestinationRoute {
  projectName: string;
  sourceProjectName?: string;
}

export type CaptureDestinationRoutes = Record<string, CaptureDestinationRoute>;

export interface CaptureInput {
  integration: string;
  sessionId: string;
  turnId: string;
  eventId: string;
  runId: string;
  destinationFingerprint: string;
  eventKind: string;
  normalizedPayload: JsonValue;
  turnEvidence: JsonValue;
  metadataProvenance: JsonValue;
  sourceAgeStartedAtMs?: number;
  dependencies?: CaptureDependency[];
  destinationRoutes?: CaptureDestinationRoutes;
}

export interface CaptureOutcome {
  outcome: "delivered" | "dropped";
  reason?: string;
  recordedAt: string;
}

export interface CaptureMarkerEntry {
  runId: string;
  outcomes: Record<string, CaptureOutcome>;
}

export interface CaptureSettledTurn {
  rootRunId: string;
  attribution: Record<string, string>;
}

export interface CaptureOutcomeMarker {
  version: number;
  settled?: CaptureSettledTurn;
  entries: Record<string, CaptureMarkerEntry>;
  unsettled: CaptureOutcome;
}

export interface CaptureRemoveOptions {
  forgetTurn?: boolean;
}

export interface CaptureRetry {
  failures: number;
  notBeforeMs: number;
  recordedAtMs?: number;
}

export interface CaptureDelivery {
  retries: Record<string, CaptureRetry>;
  outcomes: Record<string, CaptureOutcome>;
}

export interface StoredCapture extends CaptureInput {
  version: number;
  capturedAtMs: number;
  delivery?: CaptureDelivery;
}

export interface EnumeratedCapture {
  record: StoredCapture;
  capturedAtMs: number;
  modifiedAtMs: number;
}

export interface EnumeratedCaptureSession {
  sessionId: string;
  captures: EnumeratedCapture[];
}

export type StorageFailure = { status: "failed"; code: string; message: string };

export type CaptureWriteResult =
  | { status: "published"; record: StoredCapture }
  | { status: "duplicate"; record: StoredCapture }
  | { status: "conflict" }
  | StorageFailure;

export interface OutcomeInput extends CaptureScope {
  destination: string;
  outcome: "delivered" | "dropped";
  reason?: string;
}

export interface OutcomeReceipt extends CaptureScope, CaptureOutcome {
  destination: string;
}

export type OutcomeWriteResult =
  | { status: "recorded"; receipt: OutcomeReceipt }
  | { status: "duplicate"; receipt: OutcomeReceipt }
  | { status: "conflict" }
  | { status: "missing-capture" }
  | StorageFailure;

export type OutcomeReadResult =
  | { status: "pending" }
  | { status: "settled"; receipt: OutcomeReceipt }
  | { status: "missing-capture" }
  | StorageFailure;

export interface CaptureStore {
  capture(input: CaptureInput): Promise<CaptureWriteResult>;
  read(scope: CaptureScope): Promise<StoredCapture | undefined>;
  remove(scope: CaptureScope, options?: CaptureRemoveOptions): Promise<void>;
  removeTurn(records: readonly StoredCapture[], settled?: CaptureSettledTurn): Promise<void>;
  readSettledTurn(
    integration: string,
    sessionId: string,
    turnId: string,
  ): Promise<CaptureSettledTurn | undefined>;
  removeStaleMarkers(integration: string, modifiedBeforeMs: number): Promise<number>;
  readDroppedRunIds(
    integration: string,
    sessionId: string,
    turnId: string,
  ): Promise<ReadonlySet<string>>;
  enumerate(integration: string, sessionId: string): Promise<EnumeratedCapture[]>;
  enumerateTurn(
    integration: string,
    sessionId: string,
    turnId: string,
  ): Promise<EnumeratedCapture[]>;
  enumerateSessions(integration: string): Promise<EnumeratedCaptureSession[]>;
  recordRetry(scope: CaptureScope, destination: string, retry: CaptureRetry): Promise<void>;
  recordOutcome(input: OutcomeInput): Promise<OutcomeWriteResult>;
  readOutcome(scope: CaptureScope, destination: string): Promise<OutcomeReadResult>;
}

export interface CaptureOrderKey {
  capturedAtMs: number;
  eventId: string;
}

export interface CaptureLiveTurnSpan {
  firstMs: number;
  latestMs: number;
}

export interface ExpiredCaptureOptions {
  store: CaptureStore;
  integration: string;
  destinations: readonly string[];
  accountFingerprint?: string;
  now: number;
  maxAgeMs: number;
}
