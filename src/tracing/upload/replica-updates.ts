import { isPlainRecord } from "../../utils/validation/objects.js";
import type {
  LangSmithRunUpdate,
  PreparedRunSubmission,
  ResolvedUploadDestination,
} from "./models.js";

export function applyReplicaPatchUpdates(
  payload: LangSmithRunUpdate,
  destination: ResolvedUploadDestination,
  privacyMode: PreparedRunSubmission["privacyMode"],
): void {
  if (privacyMode !== "full" || destination.updates === undefined) return;
  const mutablePayload = payload as Record<string, unknown>;
  for (const [field, value] of Object.entries(destination.updates)) {
    if (field === "inputs" || (field === "end_time" && payload.end_time === undefined)) continue;
    if (field === "extra") {
      mutablePayload.extra = mergeReplicaExtra(mutablePayload.extra, value);
    } else {
      mutablePayload[field] = structuredClone(value);
    }
  }
}

function mergeReplicaExtra(baseValue: unknown, updateValue: unknown): Record<string, unknown> {
  const baseExtra = isPlainRecord(baseValue) ? baseValue : {};
  const updateExtra = isPlainRecord(updateValue) ? structuredClone(updateValue) : {};
  const baseMetadata = isPlainRecord(baseExtra["metadata"]) ? baseExtra["metadata"] : {};
  const updateMetadata = isPlainRecord(updateExtra["metadata"]) ? updateExtra["metadata"] : {};
  return {
    ...baseExtra,
    ...updateExtra,
    metadata: { ...updateMetadata, ...baseMetadata },
  };
}
