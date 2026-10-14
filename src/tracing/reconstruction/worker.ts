import { CAPTURE_JOBS_DIRECTORY } from "../../storage/capture/constants.js";
import { join, resolve } from "node:path";
import { tryAcquireFileLock } from "../../storage/index.js";
import { removeEmptyLockFolders } from "../../storage/lock-folders.js";
import { createCaptureStore, removeExpiredCaptures } from "../../storage/capture/index.js";
import type { CaptureWriteResult } from "../../storage/capture/models.js";
import {
  identifierHash,
  sessionSegments,
  validateIdentifier,
  validateIntegration,
} from "../../storage/capture/paths.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import { readSavedCaptureWake } from "../capture-wake.js";
import { captureContentDigest } from "../../storage/capture/utils/digest.js";
import { DELIVERY_CAPACITY_REASON } from "../delivery/constants.js";
import { resolvePolicy } from "../delivery/options.js";
import { requireNonBlankString } from "../../utils/validation/objects.js";
import {
  RECONSTRUCTION_CALLBACKS_REQUIRED_MESSAGE,
  RECONSTRUCTION_DRAIN_LOCK,
  RECONSTRUCTION_DRAIN_TIME_MESSAGE,
  RECONSTRUCTION_JOB_MISSING_MESSAGE,
  RECONSTRUCTION_RECORD_UNSUPPORTED_MESSAGE,
  RECONSTRUCTION_JOB_KIND,
  RECONSTRUCTION_MAPPING_KIND,
} from "./constants.js";
import type {
  ReconstructionCandidate,
  ReconstructionDrainCounts,
  ReconstructionDrainOptions,
  ReconstructionDrainResult,
  ReconstructionJobContext,
  ReconstructionJobInput,
  ReconstructionPendingSummary,
  ReconstructionWorker,
  ReconstructionWorkerContext,
  ReconstructionWorkerOptions,
} from "./models.js";
import { scopeOf } from "../../storage/capture/scope.js";
import { processJob, recordTerminal, removeJob } from "./job-processing.js";
import { jobRecord, readJob, readMapping } from "./job-records.js";
import { validateJobInput } from "./job-validation.js";

export function createReconstructionWorker(
  options: ReconstructionWorkerOptions,
): ReconstructionWorker {
  const integration = options.integration;
  const sessionId = requireNonBlankString(options.sessionId, "Session ID");
  const accountFingerprint = requireNonBlankString(
    options.bridge.accountFingerprint,
    "Account fingerprint",
  );
  const bridge = Object.freeze({ accountFingerprint, capture: options.bridge.capture });
  const reconstruct = options.reconstruct;
  if (typeof bridge.capture !== "function" || typeof reconstruct !== "function")
    throw new TypeError(RECONSTRUCTION_CALLBACKS_REQUIRED_MESSAGE);
  validateIntegration(integration);
  validateIdentifier(sessionId, "session ID");
  validateIdentifier(accountFingerprint, "account fingerprint");
  const policy = resolvePolicy(options.policy);
  const storageRoot = resolve(options.storageRoot);
  const captureStore = createCaptureStore(storageRoot, CAPTURE_JOBS_DIRECTORY);
  const context: ReconstructionWorkerContext = {
    integration,
    sessionId,
    accountFingerprint,
    policy,
    storageRoot,
    captureStore,
    bridge,
    reconstruct,
  };

  return {
    async enqueue(input: ReconstructionJobInput): Promise<CaptureWriteResult> {
      const job = validateJobInput(input, integration, sessionId, accountFingerprint);
      return captureStore.capture(jobRecord(job));
    },
    async readSavedWake(error: unknown, input: ReconstructionJobInput) {
      const job = validateJobInput(input, integration, sessionId, accountFingerprint);
      const expected = jobRecord(job);
      const saved = await readSavedCaptureWake(error, {
        store: captureStore,
        integration,
        sessionId,
        turnId: job.turnId,
        destinationFingerprint: accountFingerprint,
        eventId: job.eventId,
        runId: expected.runId,
      });
      if (saved === undefined) return undefined;
      return captureContentDigest(saved.record) === captureContentDigest(expected)
        ? saved
        : undefined;
    },
    drain: (request: ReconstructionDrainOptions = {}) => drainJobs(context, request),
  };
}

async function drainJobs(
  context: ReconstructionWorkerContext,
  request: ReconstructionDrainOptions,
): Promise<ReconstructionDrainResult> {
  const now = request.now ?? Date.now();
  if (!Number.isFinite(now)) throw new RangeError(RECONSTRUCTION_DRAIN_TIME_MESSAGE);
  const lockDirectory = await ensurePrivateDirectory(
    context.storageRoot,
    sessionSegments(identifierHash(context.sessionId)),
  );
  const lockPath = join(lockDirectory, RECONSTRUCTION_DRAIN_LOCK);
  const lock = await tryAcquireFileLock(lockPath);
  if (!lock) return { status: "busy" };
  const counts: ReconstructionDrainCounts = { captured: 0, deferred: 0, failed: 0, dropped: 0 };
  try {
    counts.dropped += await removeExpiredCaptures({
      store: context.captureStore,
      integration: context.integration,
      destinations: [context.accountFingerprint],
      accountFingerprint: context.accountFingerprint,
      now,
      maxAgeMs: context.policy.maxAgeMs,
    });
    const candidates = await collectCandidates(context);
    const overCapacity = Math.max(0, candidates.length - context.policy.maxEntries);
    await dropOverCapacity(context, candidates.slice(0, overCapacity), counts);
    await processCandidates(context, candidates.slice(overCapacity), counts);
  } finally {
    await lock.release();
    await removeEmptyLockFolders(lockPath, context.storageRoot);
  }
  return { status: "drained", ...counts, ...(await summarizePending(context)) };
}

async function collectCandidates(
  context: ReconstructionWorkerContext,
): Promise<ReconstructionCandidate[]> {
  const { captureStore, integration, sessionId, accountFingerprint } = context;
  const entries = await captureStore.enumerate(integration, sessionId);
  const candidates: ReconstructionCandidate[] = [];
  for (const entry of entries) {
    if (entry.record.eventKind === RECONSTRUCTION_MAPPING_KIND) {
      readMapping(entry.record);
      continue;
    }
    if (entry.record.eventKind !== RECONSTRUCTION_JOB_KIND)
      throw new Error(RECONSTRUCTION_RECORD_UNSUPPORTED_MESSAGE);
    const job = readJob(entry.record, integration);
    const scope = scopeOf(entry.record);
    const outcome = await captureStore.readOutcome(scope, job.accountFingerprint);
    if (outcome.status === "failed") throw new Error(outcome.message);
    if (outcome.status === "missing-capture") throw new Error(RECONSTRUCTION_JOB_MISSING_MESSAGE);
    if (outcome.status === "settled") {
      if (job.accountFingerprint === accountFingerprint && outcome.receipt.outcome === "delivered")
        await removeJob(captureStore, job);
      continue;
    }
    if (job.accountFingerprint !== accountFingerprint) continue;
    candidates.push({ entry, job, scope });
  }
  return candidates;
}

async function dropOverCapacity(
  context: ReconstructionWorkerContext,
  dropped: readonly ReconstructionCandidate[],
  counts: ReconstructionDrainCounts,
): Promise<void> {
  for (const candidate of dropped) {
    counts.dropped += Number(
      await recordTerminal(
        context.captureStore,
        candidate.scope,
        candidate.job.accountFingerprint,
        "dropped",
        DELIVERY_CAPACITY_REASON,
      ),
    );
    await removeJob(context.captureStore, candidate.job);
  }
}

async function processCandidates(
  context: ReconstructionWorkerContext,
  candidates: readonly ReconstructionCandidate[],
  counts: ReconstructionDrainCounts,
): Promise<void> {
  const jobContext: ReconstructionJobContext = {
    store: context.captureStore,
    bridge: context.bridge,
    reconstruct: context.reconstruct,
    retryBaseMs: context.policy.retryBaseMs,
    counts,
  };
  for (const candidate of candidates) {
    if ((await processJob(candidate, jobContext)) === "deferred") counts.deferred += 1;
  }
}

async function summarizePending(
  context: ReconstructionWorkerContext,
): Promise<ReconstructionPendingSummary> {
  const { captureStore, integration, sessionId, accountFingerprint } = context;
  const entries = await captureStore.enumerate(integration, sessionId);
  let pending = 0;
  let nextRetryAtMs: number | undefined;
  let accountMismatch = 0;
  for (const entry of entries) {
    if (entry.record.eventKind !== RECONSTRUCTION_JOB_KIND) continue;
    const job = readJob(entry.record, integration);
    const outcome = await captureStore.readOutcome(scopeOf(entry.record), job.accountFingerprint);
    if (outcome.status === "failed") throw new Error(outcome.message);
    if (outcome.status !== "settled") {
      pending += 1;
      if (job.accountFingerprint !== accountFingerprint) accountMismatch += 1;
      const retry = entry.record.delivery?.retries[job.accountFingerprint];
      if (retry !== undefined && (nextRetryAtMs === undefined || retry.notBeforeMs < nextRetryAtMs))
        nextRetryAtMs = retry.notBeforeMs;
    }
  }
  return {
    pending,
    ...(nextRetryAtMs === undefined ? {} : { nextRetryAtMs }),
    accountMismatch,
  };
}
