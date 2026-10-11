import { requireTimestamp } from "../../utils/validation/objects.js";
import type { ProjectedCapture } from "./models.js";

export function hasCausalRunError(events: readonly ProjectedCapture[]): boolean {
  let hasError = false;
  for (const { payload } of events) {
    if (payload.operation === "post") {
      hasError = payload.run.error !== undefined || payload.privacyContext?.status === "error";
    } else if (payload.patch.fields.includes("error")) {
      hasError = payload.patch.values.error !== undefined;
    } else if (payload.privacyContext.status === "error") {
      hasError = true;
    }
  }
  return hasError;
}

export function capturedEndTime(event: ProjectedCapture): number | string | undefined {
  if (event.payload.operation === "post") return event.payload.run.end_time;
  if (!event.payload.patch.fields.includes("end_time")) return undefined;
  const value = event.payload.patch.values.end_time;
  return value === undefined ? undefined : requireTimestamp(value);
}

export function retainedEndTime(events: readonly ProjectedCapture[]): number | string | undefined {
  let endTime: number | string | undefined;
  for (const event of events) {
    const captured = capturedEndTime(event);
    if (captured !== undefined) endTime = captured;
  }
  return endTime;
}
