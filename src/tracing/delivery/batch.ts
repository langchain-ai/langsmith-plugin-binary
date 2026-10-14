import type { StoredCapture } from "../../storage/capture/models.js";
import { scopeKey, scopeOf } from "../../storage/capture/scope.js";
import type { DeliveryBatch, DeliveryPendingCandidate, DeliveryWriter } from "./models.js";

export function createBatch(): DeliveryBatch {
  return { candidates: [], scopes: new Set(), runIds: new Set(), bytes: 0 };
}

function payloadBytes(record: StoredCapture): number {
  return Buffer.byteLength(JSON.stringify(record.normalizedPayload));
}

export function canJoinBatch(
  batch: DeliveryBatch,
  candidate: DeliveryPendingCandidate,
  writer: DeliveryWriter,
): boolean {
  if (batch.candidates.length === 0) return true;
  const limits = writer.batchLimits;
  return (
    batch.candidates.length < limits.maxRecords &&
    batch.bytes + payloadBytes(candidate.entry.record) <= limits.maxBytes &&
    !batch.runIds.has(candidate.entry.record.runId)
  );
}

export function joinBatch(batch: DeliveryBatch, candidate: DeliveryPendingCandidate): void {
  batch.candidates.push(candidate);
  batch.scopes.add(scopeKey(scopeOf(candidate.entry.record)));
  batch.runIds.add(candidate.entry.record.runId);
  batch.bytes += payloadBytes(candidate.entry.record);
}
