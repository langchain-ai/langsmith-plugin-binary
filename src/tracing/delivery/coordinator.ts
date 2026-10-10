import { join, resolve } from "node:path";
import { tryAcquireFileLock } from "../../storage/index.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import type {
  CaptureInput,
  CaptureScope,
  EnumeratedCapture,
  OutcomeInput,
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
  DeliveryDestination,
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
      let counts: DeliveryDrainCounts;
      try {
        counts = await drainLocked(
          captureStore,
          attemptStore,
          integration,
          sessionId,
          policy,
          drainRequest,
        );
      } finally {
        await lock.release();
      }
      const captures = await captureStore.enumerate(integration, sessionId);
      const eligible = captures.filter(
        ({ record }) => record.destinationFingerprint === writer.accountFingerprint,
      );
      return {
        status: "drained",
        ...counts,
        pending: await countPending(captureStore, eligible, writer.destinations),
        accountMismatch: captures.length - eligible.length,
      };
    },
  };
}

async function drainLocked(
  captureStore: ReturnType<typeof createCaptureStore>,
  attemptStore: ReturnType<typeof createDeliveryAttemptStore>,
  integration: string,
  sessionId: string,
  policy: DeliveryPolicy,
  request: DrainOptions,
): Promise<DeliveryDrainCounts> {
  const captures = await captureStore.enumerate(integration, sessionId);
  const eligible = captures.filter(
    ({ record }) => record.destinationFingerprint === request.writer.accountFingerprint,
  );
  let dropped = 0;
  let failed = 0;
  let delivered = 0;
  const now = request.now ?? Date.now();
  const candidates = await pendingCandidates(captureStore, eligible, request.writer.destinations);
  const expired = candidates.filter(({ entry }) => now - entry.capturedAtMs >= policy.maxAgeMs);
  for (const candidate of expired) {
    dropped += await dropPending(captureStore, candidate, DELIVERY_EXPIRED_REASON);
  }
  const fresh = candidates.filter(({ entry }) => now - entry.capturedAtMs < policy.maxAgeMs);
  const overCapacity = Math.max(0, fresh.length - policy.maxEntries);
  for (const candidate of fresh.slice(0, overCapacity)) {
    dropped += await dropPending(captureStore, candidate, DELIVERY_CAPACITY_REASON);
  }
  for (const candidate of fresh.slice(overCapacity)) {
    for (const destination of candidate.pending) {
      const attemptCount = await attemptStore.count(candidate.scope, destination.id);
      if (attemptCount >= policy.maxAttempts) {
        dropped += await recordDropped(
          captureStore,
          candidate.scope,
          destination.id,
          DELIVERY_RETRY_EXHAUSTED_REASON,
        );
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
        if (attempt >= policy.maxAttempts) {
          dropped += await recordDropped(
            captureStore,
            candidate.scope,
            destination.id,
            DELIVERY_RETRY_EXHAUSTED_REASON,
          );
        }
        continue;
      }
      await recordOutcome(captureStore, {
        ...candidate.scope,
        destination: destination.id,
        outcome: "delivered",
      });
      delivered += 1;
    }
  }
  return { delivered, dropped, failed };
}

async function pendingCandidates(
  store: ReturnType<typeof createCaptureStore>,
  entries: EnumeratedCapture[],
  destinations: readonly DeliveryDestination[],
): Promise<DeliveryPendingCandidate[]> {
  const candidates: DeliveryPendingCandidate[] = [];
  for (const entry of entries) {
    const scope = scopeOf(entry.record);
    const pending: DeliveryDestination[] = [];
    for (const destination of destinations) {
      if ((await readOutcome(store, scope, destination.id)).status === "pending")
        pending.push(destination);
    }
    if (pending.length > 0) candidates.push({ entry, scope, pending });
  }
  return candidates;
}

async function dropPending(
  store: ReturnType<typeof createCaptureStore>,
  candidate: DeliveryPendingCandidate,
  reason: string,
): Promise<number> {
  let dropped = 0;
  for (const destination of candidate.pending) {
    dropped += await recordDropped(store, candidate.scope, destination.id, reason);
  }
  return dropped;
}

async function recordDropped(
  store: ReturnType<typeof createCaptureStore>,
  scope: CaptureScope,
  destination: string,
  reason: string,
): Promise<number> {
  await recordOutcome(store, { ...scope, destination, outcome: "dropped", reason });
  return 1;
}

async function recordOutcome(store: ReturnType<typeof createCaptureStore>, input: OutcomeInput) {
  const result = await store.recordOutcome(input);
  if (result.status !== "recorded" && result.status !== "duplicate")
    throw new Error(`Could not persist ${input.outcome} delivery receipt: ${result.status}`);
}

async function readOutcome(
  store: ReturnType<typeof createCaptureStore>,
  scope: CaptureScope,
  destination: string,
): Promise<OutcomeReadResult> {
  const result = await store.readOutcome(scope, destination);
  if (result.status === "failed" || result.status === "missing-capture")
    throw new Error(`Could not read delivery receipt: ${result.status}`);
  return result;
}

async function countPending(
  store: ReturnType<typeof createCaptureStore>,
  entries: EnumeratedCapture[],
  destinations: readonly DeliveryDestination[],
): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    const scope = scopeOf(entry.record);
    for (const destination of destinations) {
      if ((await readOutcome(store, scope, destination.id)).status === "pending") count += 1;
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
