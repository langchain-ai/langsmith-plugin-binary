import { compareText } from "../../utils/compare.js";
import type { CaptureOrderKey } from "./models.js";

export function compareCaptureOrder(left: CaptureOrderKey, right: CaptureOrderKey): number {
  if (left.capturedAtMs !== right.capturedAtMs)
    return left.capturedAtMs < right.capturedAtMs ? -1 : 1;
  return compareText(left.eventId, right.eventId);
}
