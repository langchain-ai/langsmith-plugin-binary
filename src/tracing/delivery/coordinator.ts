import { join, resolve } from "node:path";
import { tryAcquireFileLock } from "../../storage/index.js";
import { removeEmptyLockFolders } from "../../storage/lock-folders.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { CaptureInput } from "../../storage/capture/models.js";
import {
  identifierHash,
  sessionSegments,
  validateIdentifier,
  validateIntegration,
} from "../../storage/capture/paths.js";
import { fillTemplate } from "../../utils/format.js";
import { isWaitingForOtherSetting } from "../../storage/capture/account.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import { DELIVERY_ACCOUNT_MISMATCH_WARNING, DELIVERY_DRAIN_LOCK } from "./constants.js";
import type {
  DeliveryCoordinator,
  DeliveryCoordinatorContext,
  DeliveryCoordinatorOptions,
  DeliveryDrainCache,
  DeliveryDrainCounts,
  DeliveryDrainResult,
  DeliveryWriter,
  DrainOptions,
} from "./models.js";
import { drainLocked } from "./drain.js";
import { resolvePolicy, snapshotWriter, validateDrainRequest } from "./options.js";
import { countPending, createDrainCache } from "./drain-cache.js";

async function drainUnderLock(
  context: DeliveryCoordinatorContext,
  request: DrainOptions,
  drainCache: DeliveryDrainCache,
): Promise<DeliveryDrainCounts | undefined> {
  const { captureStore, integration, sessionId, storageRoot, policy } = context;
  const sessionDirectory = await ensurePrivateDirectory(
    storageRoot,
    sessionSegments(identifierHash(sessionId)),
  );
  const lockPath = join(sessionDirectory, DELIVERY_DRAIN_LOCK);
  const lock = await tryAcquireFileLock(lockPath);
  if (!lock) return undefined;
  try {
    return await drainLocked(captureStore, integration, sessionId, policy, request, drainCache);
  } finally {
    await lock.release();
    await removeEmptyLockFolders(lockPath, storageRoot);
  }
}

async function summarizeDrain(
  context: DeliveryCoordinatorContext,
  writer: DeliveryWriter,
  counts: DeliveryDrainCounts,
  drainCache: DeliveryDrainCache,
): Promise<DeliveryDrainResult> {
  const captures = await context.captureStore.enumerate(context.integration, context.sessionId);
  const accountEligible = captures.filter(
    ({ record }) => record.destinationFingerprint === writer.accountFingerprint,
  );
  const { count, nextRetryAtMs } = await countPending(
    drainCache,
    accountEligible,
    writer.destinations,
  );
  const accountMismatch = captures.filter(({ record }) =>
    isWaitingForOtherSetting(record, writer.accountFingerprint),
  ).length;
  if (accountMismatch > 0 && !context.mismatchWarned.value) {
    context.mismatchWarned.value = true;
    console.warn(fillTemplate(DELIVERY_ACCOUNT_MISMATCH_WARNING, { count: accountMismatch }));
  }
  return {
    status: "drained",
    ...counts,
    pending: count,
    ...(nextRetryAtMs === undefined ? {} : { nextRetryAtMs }),
    accountMismatch,
  };
}

export function createDeliveryCoordinator(
  options: DeliveryCoordinatorOptions,
): DeliveryCoordinator {
  const { integration, sessionId } = options;
  validateIntegration(integration);
  validateIdentifier(sessionId, "session ID");
  const storageRoot = resolve(options.storageRoot);
  const context: DeliveryCoordinatorContext = {
    integration,
    sessionId,
    storageRoot,
    policy: resolvePolicy(options.policy),
    captureStore: createCaptureStore(storageRoot),
    mismatchWarned: { value: false },
  };
  return {
    capture(input) {
      const scoped: CaptureInput = { ...input, integration, sessionId };
      return context.captureStore.capture(scoped);
    },
    async drain(request) {
      const writer = snapshotWriter(request.writer);
      const drainRequest = {
        writer,
        ...(request.attempted === undefined ? {} : { attempted: request.attempted }),
      };
      validateDrainRequest(drainRequest);
      const drainCache = createDrainCache(context.captureStore);
      const counts = await drainUnderLock(context, drainRequest, drainCache);
      if (counts === undefined) return { status: "busy" };
      return summarizeDrain(context, writer, counts, drainCache);
    },
  };
}
