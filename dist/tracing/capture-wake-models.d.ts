import type { CaptureWriteResult } from "../storage/capture/models.js";
export type SavedCaptureResult = Extract<CaptureWriteResult, {
    status: "published" | "duplicate";
}>;
//# sourceMappingURL=capture-wake-models.d.ts.map