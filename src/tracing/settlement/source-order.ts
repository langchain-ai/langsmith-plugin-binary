import type { CaptureScope, StoredCapture } from "../../storage/capture/models.js";
import type { TurnSettlementReport } from "./models.js";

export function uniqueScopes(scopes: readonly CaptureScope[]): CaptureScope[] {
  const unique = new Map<string, CaptureScope>();
  for (const scope of scopes) unique.set(JSON.stringify(scope), scope);
  return [...unique.values()].toSorted(compareScopes);
}

export function captureScope(record: StoredCapture): CaptureScope {
  return {
    integration: record.integration,
    sessionId: record.sessionId,
    turnId: record.turnId,
    eventId: record.eventId,
  };
}

export function captureScopeKey(scope: CaptureScope): string {
  return JSON.stringify([scope.integration, scope.sessionId, scope.turnId, scope.eventId]);
}

export function compareScopes(left: CaptureScope, right: CaptureScope): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function compareCaptures(left: StoredCapture, right: StoredCapture): number {
  if (left.capturedAtMs !== right.capturedAtMs) return left.capturedAtMs - right.capturedAtMs;
  return left.eventId.localeCompare(right.eventId);
}

export function orderSourceCaptures(records: readonly StoredCapture[]): StoredCapture[] {
  const byScope = new Map(records.map((record) => [captureScopeKey(captureScope(record)), record]));
  const dependents = new Map(
    records.map((record) => [captureScopeKey(captureScope(record)), [] as StoredCapture[]]),
  );
  const dependencyCounts = new Map(
    records.map((record) => [captureScopeKey(captureScope(record)), 0]),
  );
  for (const record of records) {
    const recordKey = captureScopeKey(captureScope(record));
    for (const dependency of record.dependencies ?? []) {
      const prerequisite = byScope.get(captureScopeKey(dependency));
      if (prerequisite === undefined) continue;
      dependents.get(captureScopeKey(captureScope(prerequisite)))!.push(record);
      dependencyCounts.set(recordKey, dependencyCounts.get(recordKey)! + 1);
    }
  }
  const ready: StoredCapture[] = [];
  for (const record of records) {
    if (dependencyCounts.get(captureScopeKey(captureScope(record))) === 0)
      pushOrderedCapture(ready, record);
  }
  const ordered: StoredCapture[] = [];
  while (ready.length > 0) {
    const record = popOrderedCapture(ready)!;
    ordered.push(record);
    for (const dependent of dependents.get(captureScopeKey(captureScope(record))) ?? []) {
      const key = captureScopeKey(captureScope(dependent));
      const count = dependencyCounts.get(key)! - 1;
      dependencyCounts.set(key, count);
      if (count === 0) pushOrderedCapture(ready, dependent);
    }
  }
  if (ordered.length !== records.length)
    throw new TypeError("Source capture dependencies contain a cycle");
  return ordered;
}

function compareSourceCaptures(left: StoredCapture, right: StoredCapture): number {
  return compareCaptures(left, right) || compareScopes(captureScope(left), captureScope(right));
}

function pushOrderedCapture(heap: StoredCapture[], record: StoredCapture): void {
  let index = heap.length;
  heap.push(record);
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const parent = heap[parentIndex]!;
    if (compareSourceCaptures(parent, record) <= 0) break;
    heap[index] = parent;
    index = parentIndex;
  }
  heap[index] = record;
}

function popOrderedCapture(heap: StoredCapture[]): StoredCapture | undefined {
  const first = heap[0];
  if (first === undefined) return undefined;
  const last = heap.pop()!;
  if (heap.length === 0) return first;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    const childIndex =
      rightIndex < heap.length && compareSourceCaptures(heap[rightIndex]!, heap[leftIndex]!) < 0
        ? rightIndex
        : leftIndex;
    const child = heap[childIndex]!;
    if (compareSourceCaptures(last, child) <= 0) break;
    heap[index] = child;
    index = childIndex;
  }
  heap[index] = last;
  return first;
}

export function groupByTurn(records: readonly StoredCapture[]): Map<string, StoredCapture[]> {
  const turns = new Map<string, StoredCapture[]>();
  for (const record of records) {
    const captures = turns.get(record.turnId) ?? [];
    captures.push(record);
    turns.set(record.turnId, captures);
  }
  return turns;
}

export function report(
  turnId: string,
  status: TurnSettlementReport["status"],
  reason: NonNullable<TurnSettlementReport["reason"]>,
  runIds: string[] = [],
  destinations: string[] = [],
): TurnSettlementReport {
  return {
    turnId,
    status,
    reason,
    ...(runIds.length === 0 ? {} : { runIds }),
    ...(destinations.length === 0 ? {} : { destinations }),
    patches: 0,
  };
}
