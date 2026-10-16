import type { CaptureScope, JsonValue, StoredCapture } from "../../storage/capture/models.js";
import { LIFECYCLE_CHILD_TURN_GRACE_MS } from "./constants.js";
import type { RemoveSettledTurnsOptions } from "./models.js";

export async function removeSettledTurns(options: RemoveSettledTurnsOptions): Promise<void> {
  const known = new Set(options.knownScopes.map(turnEventKey));
  const removable = new Map<string, StoredCapture[]>();
  for (const turnId of options.settledTurnIds) {
    const records = (
      await options.store.enumerateTurn(options.integration, options.sessionId, turnId)
    )
      .map(({ record }) => record)
      .filter((record) => record.destinationFingerprint === options.destinationFingerprint);
    if (
      records.every(
        (record) => known.has(turnEventKey(record)) && isSettled(record, options.destinations),
      )
    )
      removable.set(turnId, records);
  }
  const childTurns: [string, StoredCapture[]][] = [];
  const removedRunIds = new Set<string>();
  for (const [turnId, records] of removable) {
    if (rootParentRunId(records) !== undefined) {
      childTurns.push([turnId, records]);
      continue;
    }
    await removeRecords(options, records, turnId);
    for (const { runId } of records) removedRunIds.add(runId);
  }
  if (childTurns.length === 0) return;
  const savedRunIds = new Set(
    (await options.store.enumerate(options.integration, options.sessionId)).map(
      ({ record }) => record.runId,
    ),
  );
  let pending = childTurns;
  while (pending.length > 0) {
    const waiting: [string, StoredCapture[]][] = [];
    for (const [turnId, records] of pending) {
      const parent = rootParentRunId(records)!;
      const newest = Math.max(...records.map(({ capturedAtMs }) => capturedAtMs));
      const orphaned =
        !savedRunIds.has(parent) && Date.now() - newest >= LIFECYCLE_CHILD_TURN_GRACE_MS;
      if (!removedRunIds.has(parent) && !orphaned) {
        waiting.push([turnId, records]);
        continue;
      }
      await removeRecords(options, records, turnId);
      for (const { runId } of records) removedRunIds.add(runId);
    }
    if (waiting.length === pending.length) return;
    pending = waiting;
  }
}

async function removeRecords(
  options: RemoveSettledTurnsOptions,
  records: readonly StoredCapture[],
  turnId: string,
): Promise<void> {
  await options.store.removeTurn(records, options.settledTurns?.get(turnId));
}

function turnEventKey(scope: CaptureScope): string {
  return JSON.stringify([scope.turnId, scope.eventId]);
}

function isSettled(
  record: StoredCapture,
  destinations: RemoveSettledTurnsOptions["destinations"],
): boolean {
  return destinations.every(({ id }) => record.delivery?.outcomes[id] !== undefined);
}

function rootParentRunId(records: readonly StoredCapture[]): string | undefined {
  for (const record of records) {
    const rootRunId = field(record.turnEvidence, "rootRunId");
    if (typeof rootRunId !== "string" || record.runId !== rootRunId) continue;
    const parent = field(field(record.normalizedPayload, "run"), "parent_run_id");
    if (typeof parent === "string") return parent;
  }
  return undefined;
}

function field(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value[key]
    : undefined;
}
