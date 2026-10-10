import type { CaptureStore, CaptureWriteResult } from "../storage/capture/models.js";

export type SavedCaptureResult = Extract<CaptureWriteResult, { status: "published" | "duplicate" }>;

export interface SavedCaptureWakeOptions {
  store: Pick<CaptureStore, "read">;
  integration: string;
  sessionId: string;
  turnId: string;
  destinationFingerprint: string;
  eventId?: string;
  runId?: string;
}
