import type { CaptureWriteResult } from "../storage/capture/models.js";

export type SavedCaptureResult = Extract<CaptureWriteResult, { status: "published" | "duplicate" }>;
