import { join } from "node:path";
import { tryAcquireFileLock } from "../../storage/index.js";
import { FILE_LOCK_DIRECTORY_SUFFIX } from "../../storage/constants.js";
import type { StoredCapture } from "../../storage/capture/models.js";
import { identifierHash } from "../../storage/capture/paths.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import { removeEmptyDirectories } from "../../utils/files/cleanup.js";
import {
  LIFECYCLE_PATCH_EVENT_KIND,
  LIFECYCLE_POST_EVENT_KIND,
  LIFECYCLE_RETIRE_AFTER_MS,
  LIFECYCLE_SETTLEMENT_EVENT_KIND,
  LIFECYCLE_SETTLEMENT_LOCK_ACCOUNTS_DIRECTORY,
  LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY,
  LIFECYCLE_SETTLEMENT_LOCK_FILE,
  LIFECYCLE_SETTLEMENT_LOCK_INTEGRATIONS_DIRECTORY,
  LIFECYCLE_SETTLEMENT_LOCK_SESSIONS_DIRECTORY,
  LIFECYCLE_SNAPSHOT_LOCK_DIRECTORY,
  LIFECYCLE_SNAPSHOT_LOCK_FILE,
} from "./constants.js";
import type { RetireDeliveredTurnsOptions, RetireSettledSessionsOptions } from "./models.js";

export async function retireSettledSessions(options: RetireSettledSessionsOptions): Promise<void> {
  const retireBefore = options.now - LIFECYCLE_RETIRE_AFTER_MS;
  const retireSession = async (sessionId: string) => {
    const turns = new Map<string, StoredCapture[]>();
    for (const { record } of await options.store.enumerate(options.integration, sessionId)) {
      turns.set(record.turnId, [...(turns.get(record.turnId) ?? []), record]);
    }
    for (const [turnId, records] of turns) {
      const lastWriteMs = await options.lastSettledWrite(records);
      if (lastWriteMs === undefined || lastWriteMs > retireBefore) continue;
      await options.store.retireTurn(options.integration, sessionId, turnId, records, retireBefore);
      for (const record of records) await options.attempts.clear(record);
      await options.afterRetire?.(sessionId, turnId, records);
    }
  };
  await retireSession(options.sessionId);
  for (const { sessionId } of await options.store.enumerateSessions(options.integration)) {
    if (sessionId === options.sessionId) continue;
    const lock = await tryAcquireFileLock(await options.lockPath(sessionId));
    if (lock === undefined) continue;
    try {
      await retireSession(sessionId);
    } finally {
      await lock.release();
    }
  }
}

export async function retireDeliveredTurns(options: RetireDeliveredTurnsOptions): Promise<void> {
  const { storageRoot, integration } = options;
  await retireSettledSessions({
    ...options,
    lockPath: async (sessionId) =>
      join(
        await ensurePrivateDirectory(storageRoot, [
          LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY,
          LIFECYCLE_SETTLEMENT_LOCK_INTEGRATIONS_DIRECTORY,
          integration,
          LIFECYCLE_SETTLEMENT_LOCK_SESSIONS_DIRECTORY,
          identifierHash(sessionId),
          LIFECYCLE_SETTLEMENT_LOCK_ACCOUNTS_DIRECTORY,
          identifierHash(options.destinationFingerprint),
        ]),
        LIFECYCLE_SETTLEMENT_LOCK_FILE,
      ),
    lastSettledWrite: (records) => settledTurnLastWrite(options, records),
    afterRetire: async (sessionId, turnId, records) => {
      const turn = join(
        storageRoot,
        LIFECYCLE_SNAPSHOT_LOCK_DIRECTORY,
        "integrations",
        integration,
        "sessions",
        identifierHash(sessionId),
        "turns",
        identifierHash(turnId),
      );
      const runs = [
        ...new Set(records.map(({ runId }) => join(turn, "runs", identifierHash(runId)))),
      ];
      await removeEmptyDirectories([
        ...runs.flatMap((run) => [
          join(run, `${LIFECYCLE_SNAPSHOT_LOCK_FILE}${FILE_LOCK_DIRECTORY_SUFFIX}`),
          run,
        ]),
        join(turn, "runs"),
        turn,
        join(turn, ".."),
        join(turn, "..", ".."),
      ]);
    },
  });
}

async function settledTurnLastWrite(
  options: RetireDeliveredTurnsOptions,
  records: readonly StoredCapture[],
): Promise<number | undefined> {
  let lastWriteMs = 0;
  for (const record of records) {
    if (record.destinationFingerprint !== options.destinationFingerprint) return undefined;
    const runPayload =
      record.eventKind === LIFECYCLE_POST_EVENT_KIND ||
      record.eventKind === LIFECYCLE_PATCH_EVENT_KIND;
    if (
      runPayload
        ? record.compaction === undefined
        : record.eventKind !== LIFECYCLE_SETTLEMENT_EVENT_KIND
    )
      return undefined;
    lastWriteMs = Math.max(lastWriteMs, record.capturedAtMs);
    for (const destination of options.destinations) {
      const outcome = await options.store.readOutcome(record, destination.id);
      if (outcome.status !== "settled") return undefined;
      lastWriteMs = Math.max(lastWriteMs, Date.parse(outcome.receipt.recordedAt));
    }
  }
  return lastWriteMs;
}
