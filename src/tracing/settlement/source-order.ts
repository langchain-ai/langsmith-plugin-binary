import { compareCaptureOrder } from "../../storage/capture/order.js";
import { compareText } from "../../utils/compare.js";
import type { CaptureScope, StoredCapture } from "../../storage/capture/models.js";
import type { TurnSettlementReport } from "./models.js";
import { scopeKey, scopeOf } from "../../storage/capture/scope.js";

export function uniqueScopes(scopes: readonly CaptureScope[]): CaptureScope[] {
  const unique = new Map<string, CaptureScope>();
  for (const scope of scopes) unique.set(JSON.stringify(scope), scope);
  return [...unique.values()].toSorted(compareScopes);
}

export function compareScopes(left: CaptureScope, right: CaptureScope): number {
  return compareText(JSON.stringify(left), JSON.stringify(right));
}

export function orderSourceCaptures(records: readonly StoredCapture[]): StoredCapture[] {
  const byScope = new Map(records.map((record) => [scopeKey(scopeOf(record)), record]));
  const dependents = new Map(
    records.map((record) => [scopeKey(scopeOf(record)), [] as StoredCapture[]]),
  );
  const dependencyCounts = new Map(records.map((record) => [scopeKey(scopeOf(record)), 0]));
  for (const record of records) {
    const recordKey = scopeKey(scopeOf(record));
    for (const dependency of record.dependencies ?? []) {
      const prerequisite = byScope.get(scopeKey(dependency));
      if (prerequisite === undefined) continue;
      dependents.get(scopeKey(scopeOf(prerequisite)))!.push(record);
      dependencyCounts.set(recordKey, dependencyCounts.get(recordKey)! + 1);
    }
  }
  const ready: StoredCapture[] = [];
  for (const record of records) {
    if (dependencyCounts.get(scopeKey(scopeOf(record))) === 0) pushOrderedCapture(ready, record);
  }
  const ordered: StoredCapture[] = [];
  while (ready.length > 0) {
    const record = popOrderedCapture(ready)!;
    ordered.push(record);
    for (const dependent of dependents.get(scopeKey(scopeOf(record))) ?? []) {
      const key = scopeKey(scopeOf(dependent));
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
  return compareCaptureOrder(left, right) || compareScopes(scopeOf(left), scopeOf(right));
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
