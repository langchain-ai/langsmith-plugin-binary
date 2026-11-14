import type { LangSmithUploadWriter } from "../../tracing/upload/models.js";
import type { RunPatch, RunPost } from "../models.js";

export interface UploadQueuePolicy {
  retryBaseMs: number;
  retryMaxMs: number;
}

export interface UploadLane {
  key: string;
  writer: LangSmithUploadWriter;
  destinationId: string;
  ready: Set<QueuedRun>;
  failures: number;
  retryAt: number;
}

export interface QueuedWork {
  post?: RunPost | undefined;
  patch?: RunPatch | undefined;
}

export interface QueuedRun {
  key: string;
  runId: string;
  sessionId: string;
  lane: UploadLane;
  post?: RunPost | undefined;
  patch?: RunPatch | undefined;
  sending?: QueuedWork | undefined;
  sendAlone: boolean;
  bytes: number;
}
