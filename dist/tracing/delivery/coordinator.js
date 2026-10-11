import { join, resolve } from "node:path";
import { tryAcquireFileLock } from "../../storage/index.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import { identifierHash, validateIdentifier, validateIntegration, } from "../../storage/capture/paths.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import { DELIVERY_DIRECTORY } from "./constants.js";
import { createDeliveryAttemptStore } from "./attempt-store.js";
import { countPending, createDrainCache, drainLocked, requireDeliveredCompactionReceipts, resolvePolicy, snapshotWriter, validateDrainRequest, } from "./coordinator-internals.js";
export function createDeliveryCoordinator(options) {
    const { integration, sessionId } = options;
    validateIntegration(integration);
    validateIdentifier(sessionId, "session ID");
    const storageRoot = resolve(options.storageRoot);
    const policy = resolvePolicy(options.policy);
    const captureStore = createCaptureStore(storageRoot);
    const attemptStore = createDeliveryAttemptStore(storageRoot);
    return {
        capture(input) {
            const scoped = {
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
            if (!lock)
                return { status: "busy" };
            const drainCache = createDrainCache(captureStore);
            let counts;
            try {
                counts = await drainLocked(captureStore, attemptStore, integration, sessionId, policy, drainRequest, drainCache);
            }
            finally {
                await lock.release();
            }
            const captures = await captureStore.enumerate(integration, sessionId);
            const accountEligible = captures.filter(({ record }) => record.destinationFingerprint === writer.accountFingerprint);
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
//# sourceMappingURL=coordinator.js.map