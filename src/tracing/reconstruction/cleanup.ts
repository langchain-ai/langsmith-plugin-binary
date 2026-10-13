import { join } from "node:path";
import type { CaptureStore, StoredCapture } from "../../storage/capture/models.js";
import { identifierHash } from "../../storage/capture/paths.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import { retireSettledSessions } from "../lifecycle/cleanup.js";
import {
  RECONSTRUCTION_DRAIN_LOCK,
  RECONSTRUCTION_JOB_KIND,
  RECONSTRUCTION_MAPPING_KIND,
  RECONSTRUCTION_SESSIONS_DIRECTORY,
  RECONSTRUCTION_WORKER_DIRECTORY,
} from "./constants.js";
import type { RetireReconstructionJobsOptions } from "./models.js";

export async function retireReconstructionJobs(
  options: RetireReconstructionJobsOptions,
): Promise<void> {
  await retireSettledSessions({
    ...options,
    lockPath: async (sessionId) =>
      join(
        await ensurePrivateDirectory(options.storageRoot, [
          RECONSTRUCTION_WORKER_DIRECTORY,
          options.integration,
          RECONSTRUCTION_SESSIONS_DIRECTORY,
          identifierHash(sessionId),
        ]),
        RECONSTRUCTION_DRAIN_LOCK,
      ),
    lastSettledWrite: (records) =>
      settledJobLastWrite(options.store, options.accountFingerprint, records),
  });
}

async function settledJobLastWrite(
  store: CaptureStore,
  accountFingerprint: string,
  records: readonly StoredCapture[],
): Promise<number | undefined> {
  let lastWriteMs = 0;
  let jobs = 0;
  for (const record of records) {
    if (record.destinationFingerprint !== accountFingerprint) return undefined;
    lastWriteMs = Math.max(lastWriteMs, record.capturedAtMs);
    if (record.eventKind === RECONSTRUCTION_MAPPING_KIND) continue;
    if (record.eventKind !== RECONSTRUCTION_JOB_KIND) return undefined;
    const outcome = await store.readOutcome(record, accountFingerprint);
    if (outcome.status !== "settled") return undefined;
    lastWriteMs = Math.max(lastWriteMs, Date.parse(outcome.receipt.recordedAt));
    jobs += 1;
  }
  return jobs > 0 ? lastWriteMs : undefined;
}
