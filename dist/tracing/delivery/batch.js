import { scopeKey, scopeOf } from "../../storage/capture/scope.js";
export function createBatch() {
    return { candidates: [], scopes: new Set(), runIds: new Set(), bytes: 0 };
}
function payloadBytes(record) {
    return Buffer.byteLength(JSON.stringify(record.normalizedPayload));
}
export function canJoinBatch(batch, candidate, writer) {
    if (batch.candidates.length === 0)
        return true;
    const limits = writer.batchLimits;
    return (batch.candidates.length < limits.maxRecords &&
        batch.bytes + payloadBytes(candidate.entry.record) <= limits.maxBytes &&
        !batch.runIds.has(candidate.entry.record.runId));
}
export function joinBatch(batch, candidate) {
    batch.candidates.push(candidate);
    batch.scopes.add(scopeKey(scopeOf(candidate.entry.record)));
    batch.runIds.add(candidate.entry.record.runId);
    batch.bytes += payloadBytes(candidate.entry.record);
}
//# sourceMappingURL=batch.js.map