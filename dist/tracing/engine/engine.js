import { createBackgroundWorker } from "../background-worker/index.js";
import { createLifecycleBridge } from "../lifecycle/index.js";
import { createReconstructionWorker } from "../reconstruction/index.js";
import { wakeCapturedWork } from "../capture-wake.js";
import { lifecyclePassResult, reconstructionPassResult } from "./pass-results.js";
import { snapshotEngineOptions, snapshotSessionOptions } from "./options.js";
import { recoverTracingSessions } from "./recovery.js";
export function createTracingEngine(options) {
    const config = snapshotEngineOptions(options);
    function forSession(sessionOptions) {
        return createSession(snapshotSessionOptions(sessionOptions));
    }
    function createSession(session) {
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
            async captureSnapshot(input) {
                return lifecycleBridge.captureSnapshot(input);
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
            async recoverSessions(request) {
                return recoverTracingSessions({
                    storageRoot: config.storageRoot,
                    integration: config.integration,
                    accountFingerprint: lifecycleBridge.accountFingerprint,
                    writer: config.writer,
                    currentSessionId: session.sessionId,
                    wakeCurrent: () => backgroundWorker.wake(),
                    createSession: (sessionOptions) => createSession(snapshotSessionOptions(sessionOptions)),
                }, request);
            },
        });
    }
    return Object.freeze({ forSession });
}
//# sourceMappingURL=engine.js.map