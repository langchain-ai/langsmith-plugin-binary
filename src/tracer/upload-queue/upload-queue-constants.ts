import type { UploadQueuePolicy } from "./upload-queue-models.js";

export const UPLOAD_QUEUE_MAX_REQUESTS_IN_FLIGHT = 4;
export const MAX_QUEUED_BYTES = 40 * 1024 * 1024;
export const MAX_QUEUED_RUNS = 5_000;
export const UPLOAD_QUEUE_POLICY: UploadQueuePolicy = { retryBaseMs: 500, retryMaxMs: 10_000 };
export const UPLOAD_QUEUE_PATCH_FIELDS = ["inputs", "outputs", "end_time", "error"] as const;
export const UPLOAD_QUEUE_RETRY_LOG =
  "Upload of {count} runs to {destination} failed, retrying in {delayMs} ms: {reason}";
export const UPLOAD_QUEUE_DROPPED_LOG =
  "DROPPED run {runId} of session {sessionId} on {destination}, since LangSmith rejected it for good: {reason}{hint}";
export const UPLOAD_QUEUE_WRITER_FAILED_LOG =
  "DROPPED every run for an upload setting that could not be used: {reason}";
