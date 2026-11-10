import type { CaptureDelivery, JsonValue, StoredCapture } from "./models.js";
import { isPlainRecord } from "../../utils/validation/objects.js";
import { captureContentDigest } from "./utils/digest.js";

export function withoutSentContent(
  record: StoredCapture,
  delivery: CaptureDelivery,
): StoredCapture {
  const destinations = Object.keys(record.destinationRoutes ?? {});
  if (destinations.length === 0 || destinations.some((id) => delivery.outcomes[id] === undefined))
    return record;
  const payload = record.normalizedPayload;
  if (!isPlainRecord(payload) || payload.operation !== "post" || !isPlainRecord(payload.run))
    return record;
  const { inputs, outputs, ...run } = payload.run;
  const keepsInputs = record.runId === record.turnId;
  if (outputs === undefined && keepsInputs) return record;
  return {
    ...record,
    contentDigest: record.contentDigest ?? captureContentDigest(record),
    normalizedPayload: {
      ...payload,
      run: { ...run, inputs: keepsInputs ? inputs : {} },
    } as JsonValue,
  };
}
