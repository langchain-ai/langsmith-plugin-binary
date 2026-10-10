import { join, resolve } from "node:path";
import { tryAcquireFileLock } from "../../storage/index.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import type {
  CaptureInput,
  CaptureScope,
  EnumeratedCapture,
  OutcomeReadResult,
  StoredCapture,
} from "../../storage/capture/models.js";
import {
  identifierHash,
  validateIdentifier,
  validateIntegration,
} from "../../storage/capture/paths.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import {
  DELIVERY_CAPACITY_REASON,
  DELIVERY_DEPENDENCY_DROPPED_REASON,
  DELIVERY_DEFAULT_MAX_AGE_MS,
  DELIVERY_DEFAULT_MAX_ATTEMPTS,
  DELIVERY_DEFAULT_MAX_ENTRIES,
  DELIVERY_DIRECTORY,
  DELIVERY_EXPIRED_REASON,
  DELIVERY_RETRY_EXHAUSTED_REASON,
} from "./constants.js";
import { createDeliveryAttemptStore } from "./attempt-store.js";
import type {
  DeliveryCoordinator,
  DeliveryCoordinatorOptions,
  DeliveryDependencyState,
  DeliveryDestination,
  DeliveryDrainCache,
  DeliveryDrainCounts,
  DeliveryPendingCandidate,
  DeliveryPolicy,
  DrainOptions,
} from "./models.js";

export function createDeliveryCoordinator(
  options: DeliveryCoordinatorOptions,
): DeliveryCoordinator {
  const { integration, sessionId } = options;
  validateIntegration(integration);
  validateIdentifier(sessionId, "session ID");
  const storageRoot = resolve(options.storageRoot);
  const policy = resolvePolicy(options.policy);
  const captureStore = createCaptureStore(storageRoot);
  const attemptStore = createDeliveryAttemptStore(storageRoot);
  return {
    capture(input) {
      const scoped: CaptureInput = {
        ...input,
        integration,
        sessionId,
      };
      return captureStore.capture(scoped);
    },
    async drain(request) {
      const writer = snapshotWriter(request.writer);
      const drainRequest = {
        writer,
        ...(request.now === undefined ? {} : { now: request.now }),
      };
      validateDrainRequest(drainRequest);
      const sessionDirectory = await ensurePrivateDirectory(storageRoot, [
        DELIVERY_DIRECTORY,
        "integrations",
        integration,
        "sessions",
        identifierHash(sessionId),
      ]);
      const lock = await tryAcquireFileLock(join(sessionDirectory, "drain"));
      if (!lock) return { status: "busy" };
      const drainCache = createDrainCache(captureStore);
      let counts: DeliveryDrainCounts;
      try {
        counts = await drainLocked(
          captureStore,
          attemptStore,
          integration,
          sessionId,
          policy,
          drainRequest,
          drainCache,
        );
      } finally {
        await lock.release();
      }
      const captures = await captureStore.enumerate(integration, sessionId);
      const accountEligible = captures.filter(
        ({ record }) => record.destinationFingerprint === writer.accountFingerprint,
      );
      await requireDeliveredCompactionReceipts(captureStore, accountEligible, writer.destinations);
      const eligible = accountEligible.filter(({ record }) => record.compaction === undefined);
      return {
        status: "drained",
        ...counts,
        pending: await countPending(drainCache, eligible, writer.destinations),
        accountMismatch: captures.length - accountEligible.length,
      };
    },
  };
}

async function requireDeliveredCompactionReceipts(
  captureStore: ReturnType<typeof createCaptureStore>,
  captures: EnumeratedCapture[],
  destinations: readonly DeliveryDestination[],
): Promise<void> {
  for (const { record } of captures) {
    if (record.compaction === undefined) continue;
    const scope = scopeOf(record);
    for (const destination of destinations) {
      const outcome = await captureStore.readOutcome(scope, destination.id);
      if (outcome.status === "failed")
        throw new Error(`Could not verify compacted capture receipt: ${outcome.code}`);
      if (outcome.status !== "settled" || outcome.receipt.outcome !== "delivered") {
        throw new Error(
          `Compacted capture ${record.eventId} has no delivered receipt for destination ${destination.id}`,
        );
      }
    }
  }
}

async function drainLocked(
  captureStore: ReturnType<typeof createCaptureStore>,
  attemptStore: ReturnType<typeof createDeliveryAttemptStore>,
  integration: string,
  sessionId: string,
  policy: DeliveryPolicy,
  request: DrainOptions,
  drainCache: DeliveryDrainCache,
): Promise<DeliveryDrainCounts> {
  const captures = await captureStore.enumerate(integration, sessionId);
  const eligible = captures.filter(
    ({ record }) =>
      record.destinationFingerprint === request.writer.accountFingerprint &&
      record.compaction === undefined,
  );
  for (const { record } of eligible) drainCache.rememberCapture(record);
  let dropped = 0;
  let failed = 0;
  let delivered = 0;
  const now = request.now ?? Date.now();
  const candidates = await pendingCandidates(drainCache, eligible, request.writer.destinations);
  for (const candidate of candidates) {
    const pending: DeliveryDestination[] = [];
    for (const destination of candidate.pending) {
      const dependencyState = await dependenciesForDestination(
        drainCache,
        candidate.entry.record,
        destination.id,
      );
      if (dependencyState === "dropped") {
        dropped += await recordDropped(
          drainCache,
          candidate.scope,
          destination.id,
          DELIVERY_DEPENDENCY_DROPPED_REASON,
        );
      } else {
        pending.push(destination);
      }
    }
    candidate.pending = pending;
  }
  const active = candidates.filter((candidate) => candidate.pending.length > 0);
  const expired = active.filter(
    ({ entry }) =>
      now - (entry.record.sourceAgeStartedAtMs ?? entry.capturedAtMs) >= policy.maxAgeMs,
  );
  for (const candidate of expired) {
    dropped += await dropPending(drainCache, candidate, DELIVERY_EXPIRED_REASON);
  }
  const fresh = active.filter(
    ({ entry }) =>
      now - (entry.record.sourceAgeStartedAtMs ?? entry.capturedAtMs) < policy.maxAgeMs,
  );
  const overCapacity = Math.max(0, fresh.length - policy.maxEntries);
  for (const candidate of fresh.slice(0, overCapacity)) {
    dropped += await dropPending(drainCache, candidate, DELIVERY_CAPACITY_REASON);
  }
  const sendable = fresh.slice(overCapacity);
  const attempted = new Set<string>();
  let progressed: boolean;
  do {
    progressed = false;
    for (const candidate of sendable) {
      for (const destination of candidate.pending) {
        const key = deliveryKey(candidate.scope, destination.id);
        if (attempted.has(key)) continue;
        const dependencyState = await dependenciesForDestination(
          drainCache,
          candidate.entry.record,
          destination.id,
        );
        if (dependencyState === "pending") continue;
        attempted.add(key);
        if (dependencyState === "dropped") {
          dropped += await recordDropped(
            drainCache,
            candidate.scope,
            destination.id,
            DELIVERY_DEPENDENCY_DROPPED_REASON,
          );
          progressed = true;
          continue;
        }
        const attemptCount = await attemptStore.count(candidate.scope, destination.id);
        const remainingAttempts =
          policy.maxAttempts - (candidate.entry.record.priorDeliveryAttempts ?? 0);
        if (attemptCount >= remainingAttempts) {
          dropped += await recordDropped(
            drainCache,
            candidate.scope,
            destination.id,
            DELIVERY_RETRY_EXHAUSTED_REASON,
          );
          progressed = true;
          continue;
        }
        const attempt = attemptCount + 1;
        await attemptStore.record(
          candidate.scope,
          destination.id,
          attempt,
          new Date(now).toISOString(),
        );
        if (candidate.entry.record.destinationFingerprint !== request.writer.accountFingerprint)
          continue;
        try {
          await request.writer.send(
            structuredClone(candidate.entry.record),
            destination,
            request.writer.accountFingerprint,
          );
        } catch {
          failed += 1;
          if (attempt >= remainingAttempts) {
            dropped += await recordDropped(
              drainCache,
              candidate.scope,
              destination.id,
              DELIVERY_RETRY_EXHAUSTED_REASON,
            );
            progressed = true;
          }
          continue;
        }
        await drainCache.recordOutcome({
          ...candidate.scope,
          destination: destination.id,
          outcome: "delivered",
        });
        delivered += 1;
        progressed = true;
      }
    }
  } while (progressed);
  return { delivered, dropped, failed };
}

async function pendingCandidates(
  drainCache: DeliveryDrainCache,
  entries: EnumeratedCapture[],
  destinations: readonly DeliveryDestination[],
): Promise<DeliveryPendingCandidate[]> {
  const candidates: DeliveryPendingCandidate[] = [];
  for (const entry of entries) {
    const scope = scopeOf(entry.record);
    const pending: DeliveryDestination[] = [];
    for (const destination of destinations) {
      if ((await requireOutcome(drainCache, scope, destination.id)).status === "pending")
        pending.push(destination);
    }
    if (pending.length > 0) candidates.push({ entry, scope, pending });
  }
  return candidates;
}

async function dependenciesForDestination(
  drainCache: DeliveryDrainCache,
  dependent: StoredCapture,
  destination: string,
): Promise<DeliveryDependencyState> {
  let pending = false;
  for (const dependency of dependent.dependencies ?? []) {
    const prerequisite = await drainCache.read(dependency);
    if (prerequisite === undefined) {
      pending = true;
      continue;
    }
    if (prerequisite.destinationFingerprint !== dependent.destinationFingerprint) {
      pending = true;
      continue;
    }
    const outcome = await drainCache.readOutcome(dependency, destination);
    if (outcome.status === "failed")
      throw new Error(`Could not read prerequisite receipt: ${outcome.status}`);
    if (outcome.status === "pending" || outcome.status === "missing-capture") {
      pending = true;
      continue;
    }
    if (outcome.receipt.outcome === "dropped") return "dropped";
  }
  return pending ? "pending" : "ready";
}

function deliveryKey(scope: CaptureScope, destination: string): string {
  return JSON.stringify([
    scope.integration,
    scope.sessionId,
    scope.turnId,
    scope.eventId,
    destination,
  ]);
}

async function dropPending(
  drainCache: DeliveryDrainCache,
  candidate: DeliveryPendingCandidate,
  reason: string,
): Promise<number> {
  let dropped = 0;
  for (const destination of candidate.pending) {
    dropped += await recordDropped(drainCache, candidate.scope, destination.id, reason);
  }
  return dropped;
}

async function recordDropped(
  drainCache: DeliveryDrainCache,
  scope: CaptureScope,
  destination: string,
  reason: string,
): Promise<number> {
  await drainCache.recordOutcome({ ...scope, destination, outcome: "dropped", reason });
  return 1;
}

function createDrainCache(store: ReturnType<typeof createCaptureStore>): DeliveryDrainCache {
  const captures = new Map<string, Promise<StoredCapture | undefined>>();
  const outcomes = new Map<string, Promise<OutcomeReadResult>>();
  return {
    read(scope) {
      const key = captureKey(scope);
      let record = captures.get(key);
      if (record === undefined) {
        record = store.read(scope);
        captures.set(key, record);
      }
      return record;
    },
    readOutcome(scope, destination) {
      const key = deliveryKey(scope, destination);
      let outcome = outcomes.get(key);
      if (outcome === undefined) {
        outcome = store.readOutcome(scope, destination);
        outcomes.set(key, outcome);
      }
      return outcome;
    },
    async recordOutcome(input) {
      const result = await store.recordOutcome(input);
      if (result.status !== "recorded" && result.status !== "duplicate")
        throw new Error(`Could not persist ${input.outcome} delivery receipt: ${result.status}`);
      outcomes.set(
        deliveryKey(input, input.destination),
        Promise.resolve({
          status: "settled",
          receipt: result.receipt,
        }),
      );
      return result.receipt;
    },
    rememberCapture(record) {
      captures.set(captureKey(record), Promise.resolve(record));
    },
  };
}

function captureKey(scope: CaptureScope): string {
  return JSON.stringify([scope.integration, scope.sessionId, scope.turnId, scope.eventId]);
}

async function requireOutcome(
  drainCache: DeliveryDrainCache,
  scope: CaptureScope,
  destination: string,
): Promise<OutcomeReadResult> {
  const result = await drainCache.readOutcome(scope, destination);
  if (result.status === "failed" || result.status === "missing-capture")
    throw new Error(`Could not read delivery receipt: ${result.status}`);
  return result;
}

async function countPending(
  drainCache: DeliveryDrainCache,
  entries: EnumeratedCapture[],
  destinations: readonly DeliveryDestination[],
): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    const scope = scopeOf(entry.record);
    for (const destination of destinations) {
      if ((await requireOutcome(drainCache, scope, destination.id)).status === "pending")
        count += 1;
    }
  }
  return count;
}

function scopeOf(record: StoredCapture): CaptureScope {
  return {
    integration: record.integration,
    sessionId: record.sessionId,
    turnId: record.turnId,
    eventId: record.eventId,
  };
}

function validateDrainRequest(request: DrainOptions): void {
  if (request.writer === null || typeof request.writer !== "object")
    throw new TypeError("A delivery writer is required");
  validateIdentifier(request.writer.accountFingerprint, "account fingerprint");
  if (!Array.isArray(request.writer.destinations) || request.writer.destinations.length === 0)
    throw new TypeError("At least one delivery destination is required");
  const ids = new Set<string>();
  for (const destination of request.writer.destinations) {
    validateIdentifier(destination.id, "destination");
    if (ids.has(destination.id)) throw new TypeError("Delivery destinations must be unique");
    ids.add(destination.id);
  }
  if (typeof request.writer.send !== "function")
    throw new TypeError("A delivery transport is required");
  if (
    request.now !== undefined &&
    (!Number.isSafeInteger(request.now) || !Number.isFinite(new Date(request.now).getTime()))
  ) {
    throw new TypeError("Invalid delivery clock");
  }
}

function snapshotWriter(writer: DrainOptions["writer"]): DrainOptions["writer"] {
  if (writer === null || typeof writer !== "object")
    throw new TypeError("A delivery writer is required");
  const accountFingerprint = writer.accountFingerprint;
  const sourceDestinations = writer.destinations;
  const send = writer.send;
  if (!Array.isArray(sourceDestinations) || sourceDestinations.length === 0)
    throw new TypeError("At least one delivery destination is required");
  const destinations = sourceDestinations.map((destination) => {
    if (destination === null || typeof destination !== "object")
      throw new TypeError("Invalid delivery destination");
    return Object.freeze({ id: destination.id });
  });
  return Object.freeze({
    accountFingerprint,
    destinations: Object.freeze(destinations),
    send: typeof send === "function" ? send.bind(writer) : send,
  });
}

function resolvePolicy(policy: Partial<DeliveryPolicy> | undefined): DeliveryPolicy {
  const resolved = {
    maxAttempts: policy?.maxAttempts ?? DELIVERY_DEFAULT_MAX_ATTEMPTS,
    maxAgeMs: policy?.maxAgeMs ?? DELIVERY_DEFAULT_MAX_AGE_MS,
    maxEntries: policy?.maxEntries ?? DELIVERY_DEFAULT_MAX_ENTRIES,
  };
  if (
    !Number.isSafeInteger(resolved.maxAttempts) ||
    resolved.maxAttempts <= 0 ||
    !Number.isSafeInteger(resolved.maxAgeMs) ||
    resolved.maxAgeMs <= 0 ||
    !Number.isSafeInteger(resolved.maxEntries) ||
    resolved.maxEntries <= 0
  ) {
    throw new TypeError("Invalid delivery policy");
  }
  return resolved;
}
