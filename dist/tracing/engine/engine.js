import { createBackgroundWorker } from "../background-worker/index.js";
import { createLifecycleBridge } from "../lifecycle/index.js";
import { createReconstructionWorker } from "../reconstruction/index.js";
import { wakeCapturedWork } from "../capture-wake.js";
import { lifecyclePassResult, reconstructionPassResult } from "./pass-results.js";
import { snapshotEngineOptions, snapshotSessionOptions } from "./options.js";
export function createTracingEngine(options) {
    const config = snapshotEngineOptions(options);
    return Object.freeze({
        forSession(sessionOptions) {
            const session = snapshotSessionOptions(sessionOptions);
            let backgroundWorker;
            const lifecycleBridge = createLifecycleBridge({
                storageRoot: config.storageRoot,
                integration: config.integration,
                sessionId: session.sessionId,
                writer: config.writer,
                ...(config.policy === undefined ? {} : { policy: config.policy }),
                wake: async () => backgroundWorker?.wake(),
            });
            const reconstructionWorker = createReconstructionWorker({
                storageRoot: config.storageRoot,
                integration: config.integration,
                sessionId: session.sessionId,
                bridge: lifecycleBridge,
                reconstruct: session.reconstruct,
                ...(config.policy === undefined ? {} : { policy: config.policy }),
            });
            const scope = Object.freeze({
                integration: config.integration,
                sessionId: session.sessionId,
                accountFingerprint: lifecycleBridge.accountFingerprint,
            });
            backgroundWorker = createBackgroundWorker({
                storageRoot: config.storageRoot,
                scope,
                resolveScope: () => session.resolveScope(scope),
                launchWorker: session.scheduleWake,
                ...(session.startupWaitMs === undefined ? {} : { startupWaitMs: session.startupWaitMs }),
                ...(session.retryPolicy === undefined ? {} : { retryPolicy: session.retryPolicy }),
                reconstructPending: async () => reconstructionPassResult(await reconstructionWorker.drain()),
                drainPending: async () => lifecyclePassResult(await lifecycleBridge.drain()),
            });
            return Object.freeze({
                async capture(input) {
                    return lifecycleBridge.capture(input);
                },
                async queueReconstruction(input) {
                    const result = await reconstructionWorker.enqueue(input);
                    if (result.status === "published" || result.status === "duplicate")
                        await wakeCapturedWork(result, () => backgroundWorker?.wake());
                    return result;
                },
                async wake() {
                    return backgroundWorker.wake();
                },
                async drain() {
                    return backgroundWorker.run();
                },
            });
        },
    });
}
//# sourceMappingURL=engine.js.map