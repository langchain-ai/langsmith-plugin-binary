import { isWaitingForRetry } from "../../storage/capture/retry-state.js";
import type { CaptureRetry, CaptureScope, CaptureStore } from "../../storage/capture/models.js";
import { DELIVERY_DROPPED_WARNING } from "../delivery/constants.js";
import { nextRetry } from "../delivery/retry.js";
import type { LifecycleCaptureInput } from "../lifecycle/models.js";
import { requireOwnDataField, requirePlainRecord } from "../../utils/validation/objects.js";
import {
  RECONSTRUCTION_DEFERRAL_REASON_INVALID_MESSAGE,
  RECONSTRUCTION_DEFERRED_REASON,
  RECONSTRUCTION_NO_CAPTURES_MESSAGE,
  RECONSTRUCTION_RESULT_STATUS_INVALID_MESSAGE,
  RECONSTRUCTION_TERMINAL_OUTCOME_MESSAGE,
} from "./constants.js";
import type {
  ReconstructionCallback,
  ReconstructionCandidate,
  ReconstructionCaptureResult,
  ReconstructionInterpretation,
  ReconstructionJob,
  ReconstructionJobContext,
  ReconstructionJobProcessResult,
  ReconstructionOutput,
  ReconstructionTerminalOutcome,
  ReconstructionValidatedOutput,
} from "./models.js";
import { scopeOf } from "../../storage/capture/scope.js";
import {
  mappingRecord,
  mappingScope,
  readMapping,
  sameOutputMapping,
  snapshotJob,
} from "./job-records.js";
import { validateOutputs } from "./job-validation.js";

export async function processJob(
  candidate: ReconstructionCandidate,
  context: ReconstructionJobContext,
): Promise<ReconstructionJobProcessResult> {
  const { job, scope } = candidate;
  const retry = candidate.entry.record.delivery?.retries[job.accountFingerprint];
  if (isWaitingForRetry(retry)) return "deferred";
  const fail = async (): Promise<ReconstructionJobProcessResult> => {
    await recordFailure(context, scope, job.accountFingerprint, retry);
    return "complete";
  };
  const interpretation = await interpretReconstruction(job, context.reconstruct);
  if (interpretation === "deferred") return "deferred";
  if (interpretation === "failed") return fail();
  const outputs = validateJobOutputs(interpretation.outputs, job, candidate.entry.capturedAtMs);
  if (outputs === undefined) return fail();
  if (!(await saveOutputMapping(context.store, job, outputs))) return fail();
  const captured = await captureOutputs(context, job, outputs);
  if (captured === "deferred") return "deferred";
  if (captured === "failed") return fail();
  await recordTerminal(context.store, scope, job.accountFingerprint, "delivered");
  await removeJob(context.store, job);
  return "complete";
}

async function interpretReconstruction(
  job: ReconstructionJob,
  reconstruct: ReconstructionCallback,
): Promise<ReconstructionInterpretation> {
  try {
    const result = requirePlainRecord(await reconstruct(snapshotJob(job)), "Reconstruction result");
    const status = requireOwnDataField(result, "status");
    if (status === "deferred") {
      if (requireOwnDataField(result, "reason") !== RECONSTRUCTION_DEFERRED_REASON)
        throw new TypeError(RECONSTRUCTION_DEFERRAL_REASON_INVALID_MESSAGE);
      return "deferred";
    }
    if (status !== "ready") throw new TypeError(RECONSTRUCTION_RESULT_STATUS_INVALID_MESSAGE);
    return {
      status,
      outputs: requireOwnDataField(result, "outputs") as readonly ReconstructionOutput[],
    };
  } catch {
    return "failed";
  }
}

function validateJobOutputs(
  candidates: readonly ReconstructionOutput[],
  job: ReconstructionJob,
  jobCapturedAtMs: number,
): ReconstructionValidatedOutput[] | undefined {
  try {
    const outputs = validateOutputs(candidates, job, jobCapturedAtMs);
    if (outputs.length === 0) throw new TypeError(RECONSTRUCTION_NO_CAPTURES_MESSAGE);
    return outputs;
  } catch {
    return undefined;
  }
}

async function saveOutputMapping(
  store: CaptureStore,
  job: ReconstructionJob,
  outputs: ReconstructionValidatedOutput[],
): Promise<boolean> {
  const mappingResult = await store.capture(mappingRecord(job, outputs));
  if (mappingResult.status !== "published" && mappingResult.status !== "duplicate") return false;
  const storedMapping = readMapping(mappingResult.record);
  return storedMapping.jobEventId === job.eventId && sameOutputMapping(storedMapping, outputs);
}

function lifecycleCaptureInput(
  job: ReconstructionJob,
  output: ReconstructionValidatedOutput,
): LifecycleCaptureInput {
  const evidence = output.turnEvidence ?? job.turnEvidence;
  const turnEvidence = {
    ...(evidence.rootRunId === undefined ? {} : { rootRunId: evidence.rootRunId }),
    childRunIds: [...evidence.childRunIds],
    closureState: evidence.closureState,
  };
  return {
    turnId: job.turnId,
    eventId: output.eventId,
    submission: output.submission,
    turnEvidence,
    ...(output.dependencies === undefined ? {} : { dependencies: output.dependencies }),
    ...(output.sourceAgeStartedAtMs === undefined
      ? {}
      : { sourceAgeStartedAtMs: output.sourceAgeStartedAtMs }),
  };
}

async function captureOutputs(
  context: ReconstructionJobContext,
  job: ReconstructionJob,
  outputs: ReconstructionValidatedOutput[],
): Promise<ReconstructionCaptureResult> {
  for (const output of outputs) {
    const captureInput = lifecycleCaptureInput(job, output);
    let captureStatus: unknown;
    try {
      captureStatus = requireOwnDataField(
        requirePlainRecord(await context.bridge.capture(captureInput), "Lifecycle capture result"),
        "status",
      );
    } catch {
      return "failed";
    }
    if (captureStatus === "deferred") return "deferred";
    if (captureStatus !== "published" && captureStatus !== "duplicate") return "failed";
    if (captureStatus === "published") context.counts.captured += 1;
  }
  return "captured";
}

export async function removeJob(store: CaptureStore, job: ReconstructionJob): Promise<void> {
  await store.remove(mappingScope(job), { forgetTurn: true });
  await store.remove(scopeOf(job), { forgetTurn: true });
}

async function recordFailure(
  context: ReconstructionJobContext,
  scope: CaptureScope,
  accountFingerprint: string,
  previous: CaptureRetry | undefined,
): Promise<void> {
  await context.store.recordRetry(
    scope,
    accountFingerprint,
    nextRetry(previous, context.retryBaseMs),
  );
  context.counts.failed += 1;
}

export async function recordTerminal(
  store: CaptureStore,
  scope: CaptureScope,
  accountFingerprint: string,
  outcome: ReconstructionTerminalOutcome,
  reason?: string,
): Promise<boolean> {
  const result = await store.recordOutcome({
    ...scope,
    destination: accountFingerprint,
    outcome,
    ...(reason === undefined ? {} : { reason }),
  });
  if (result.status !== "recorded" && result.status !== "duplicate")
    throw new Error(`${RECONSTRUCTION_TERMINAL_OUTCOME_MESSAGE} ${result.status}`);
  if (outcome === "dropped" && result.status === "recorded")
    console.warn(DELIVERY_DROPPED_WARNING, `${scope.eventId} (${reason})`);
  return result.status === "recorded";
}
