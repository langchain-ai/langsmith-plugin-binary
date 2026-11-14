import { authHint, isRetryable, rejection } from "../../tracing/delivery/retry.js";
import { createLangSmithUploadWriter } from "../../tracing/upload/index.js";
import type { LangSmithUploadWriterOptions } from "../../tracing/upload/models.js";
import { describe, failureStatus } from "../../utils/errors.js";
import { fillTemplate } from "../../utils/format.js";
import type { RunPatch, RunPost, UploadQueue } from "../models.js";
import {
  MAX_QUEUED_BYTES,
  MAX_QUEUED_RUNS,
  UPLOAD_QUEUE_DROPPED_LOG,
  UPLOAD_QUEUE_MAX_REQUESTS_IN_FLIGHT,
  UPLOAD_QUEUE_POLICY,
  UPLOAD_QUEUE_RETRY_LOG,
  UPLOAD_QUEUE_WRITER_FAILED_LOG,
} from "./upload-queue-constants.js";
import type { QueuedRun, UploadLane, UploadQueuePolicy } from "./upload-queue-models.js";
import { parentKey, requeue, runKey, startSending } from "./queued-runs.js";
import { mergeRun } from "./submissions.js";

export function createUploadQueue(
  log: (line: string) => void,
  policy: UploadQueuePolicy = UPLOAD_QUEUE_POLICY,
): UploadQueue {
  const lanesByWriter = new Map<string, UploadLane[]>();
  const lanes: UploadLane[] = [];
  const runs = new Map<string, QueuedRun>();
  const waitingOnParent = new Map<string, QueuedRun[]>();
  const pendingBySession = new Map<string, number>();
  let inFlight = 0;
  let queuedBytes = 0;
  let nextLane = 0;
  let retryTimer: NodeJS.Timeout | undefined;

  function lanesFor(options: LangSmithUploadWriterOptions): UploadLane[] {
    const key = JSON.stringify(options);
    const known = lanesByWriter.get(key);
    if (known !== undefined) return known;
    let created: UploadLane[] = [];
    try {
      const writer = createLangSmithUploadWriter(options);
      created = writer.destinations.map(({ id }, index) => ({
        key: `${lanes.length + index}`,
        writer,
        destinationId: id,
        ready: new Set<QueuedRun>(),
        failures: 0,
        retryAt: 0,
      }));
    } catch (error) {
      log(fillTemplate(UPLOAD_QUEUE_WRITER_FAILED_LOG, { reason: describe(error) }));
    }
    lanesByWriter.set(key, created);
    lanes.push(...created);
    return created;
  }

  function track(sessionId: string, lane: UploadLane, runId: string): QueuedRun {
    const key = runKey(lane, runId);
    const known = runs.get(key);
    if (known !== undefined) return known;
    const run: QueuedRun = { key, runId, sessionId, lane, sendAlone: false, bytes: 0 };
    runs.set(key, run);
    pendingBySession.set(sessionId, (pendingBySession.get(sessionId) ?? 0) + 1);
    return run;
  }

  function hold(run: QueuedRun, content: RunPost | RunPatch): void {
    const bytes = Buffer.byteLength(JSON.stringify(content));
    run.bytes += bytes;
    queuedBytes += bytes;
  }

  function forget(run: QueuedRun): void {
    runs.delete(run.key);
    queuedBytes -= run.bytes;
    const left = (pendingBySession.get(run.sessionId) ?? 1) - 1;
    if (left === 0) pendingBySession.delete(run.sessionId);
    else pendingBySession.set(run.sessionId, left);
  }

  function parentUnacknowledged(key: string): boolean {
    const parent = runs.get(key);
    return parent?.post !== undefined || parent?.sending?.post !== undefined;
  }

  function releaseChildren(run: QueuedRun): void {
    for (const child of waitingOnParent.get(run.key) ?? []) child.lane.ready.add(child);
    waitingOnParent.delete(run.key);
  }

  function takeBatch(lane: UploadLane): QueuedRun[] {
    const batch: QueuedRun[] = [];
    const inBatch = new Set<string>();
    for (const run of lane.ready) {
      const parent = parentKey(run);
      if (parent !== undefined && !inBatch.has(parent) && parentUnacknowledged(parent)) {
        lane.ready.delete(run);
        const siblings = waitingOnParent.get(parent);
        if (siblings === undefined) waitingOnParent.set(parent, [run]);
        else siblings.push(run);
        continue;
      }
      if (run.sendAlone && batch.length > 0) continue;
      lane.ready.delete(run);
      batch.push(run);
      inBatch.add(run.key);
      if (run.sendAlone || batch.length >= lane.writer.batchLimits.maxRuns) break;
    }
    return batch;
  }

  function acknowledge(run: QueuedRun): void {
    const postedNow = run.sending?.post !== undefined;
    run.sending = undefined;
    if (run.post !== undefined || run.patch !== undefined) run.lane.ready.add(run);
    else forget(run);
    if (postedNow) releaseChildren(run);
  }

  function drop(run: QueuedRun, error: unknown): void {
    const { reason, status } = rejection(error);
    log(
      fillTemplate(UPLOAD_QUEUE_DROPPED_LOG, {
        runId: run.runId,
        sessionId: run.sessionId,
        destination: run.lane.destinationId,
        reason,
        hint: authHint(status),
      }),
    );
    run.sending = undefined;
    forget(run);
    releaseChildren(run);
  }

  function backOff(lane: UploadLane, count: number, error: unknown): void {
    lane.failures += 1;
    const delayMs = Math.min(policy.retryMaxMs, policy.retryBaseMs * 2 ** (lane.failures - 1));
    lane.retryAt = Date.now() + delayMs;
    log(
      fillTemplate(UPLOAD_QUEUE_RETRY_LOG, {
        count,
        destination: lane.destinationId,
        delayMs,
        reason: failureReason(error),
      }),
    );
  }

  async function send(lane: UploadLane, batch: QueuedRun[]): Promise<void> {
    const error = await Promise.resolve()
      .then(() => lane.writer.sendBatch(batch.map(startSending), lane.destinationId))
      .then(
        () => undefined,
        (failure: unknown) => failure ?? new Error(),
      );
    inFlight -= 1;
    if (error === undefined) {
      lane.failures = 0;
      for (const run of batch) acknowledge(run);
    } else if (isRetryable(error) && !(error instanceof TypeError)) {
      backOff(lane, batch.length, error);
      for (const run of batch) requeue(run);
    } else if (batch.length > 1) {
      for (const run of batch) {
        run.sendAlone = true;
        requeue(run);
      }
    } else {
      for (const run of batch) drop(run, error);
    }
    flush();
  }

  function laneToServe(now: number): UploadLane | undefined {
    for (let step = 0; step < lanes.length; step += 1) {
      const lane = lanes[(nextLane + step) % lanes.length]!;
      if (lane.ready.size > 0 && lane.retryAt <= now) {
        nextLane = (nextLane + step + 1) % lanes.length;
        return lane;
      }
    }
    return undefined;
  }

  function scheduleRetry(now: number): void {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    let earliest = Infinity;
    for (const lane of lanes) {
      if (lane.ready.size > 0 && lane.retryAt > now) earliest = Math.min(earliest, lane.retryAt);
    }
    if (earliest === Infinity) return;
    retryTimer = setTimeout(flush, earliest - now);
    retryTimer.unref();
  }

  function flush(): void {
    const now = Date.now();
    while (inFlight < UPLOAD_QUEUE_MAX_REQUESTS_IN_FLIGHT) {
      const lane = laneToServe(now);
      if (lane === undefined) break;
      const batch = takeBatch(lane);
      if (batch.length === 0) continue;
      inFlight += 1;
      void send(lane, batch);
    }
    scheduleRetry(now);
  }

  function post(sessionId: string, options: LangSmithUploadWriterOptions, run: RunPost): void {
    if (run.tracingMode === "off") return;
    for (const lane of lanesFor(options)) {
      const queued = track(sessionId, lane, run.id);
      if (queued.post !== undefined || queued.sending?.post !== undefined) continue;
      hold(queued, run);
      queued.post = mergeRun(mergeRun(run, queued.sending?.patch), queued.patch);
      queued.patch = undefined;
      if (queued.sending === undefined) lane.ready.add(queued);
    }
  }

  function patch(sessionId: string, options: LangSmithUploadWriterOptions, update: RunPatch): void {
    if (update.tracingMode === "off") return;
    for (const lane of lanesFor(options)) {
      const queued = track(sessionId, lane, update.id);
      hold(queued, update);
      if (queued.post !== undefined) {
        queued.post = mergeRun(queued.post, update);
        continue;
      }
      queued.patch = queued.patch === undefined ? update : mergeRun(queued.patch, update);
      if (queued.sending === undefined) lane.ready.add(queued);
    }
  }

  return {
    post,
    patch,
    pendingFor: (sessionId) => pendingBySession.get(sessionId) ?? 0,
    idle: () => runs.size === 0,
    full: () => queuedBytes >= MAX_QUEUED_BYTES || runs.size >= MAX_QUEUED_RUNS,
    flush,
  };
}

function failureReason(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const status = failureStatus(cause);
  return status === undefined ? describe(cause) : `${describe(cause)} (HTTP ${status})`;
}
