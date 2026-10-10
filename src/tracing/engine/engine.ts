import type { CaptureWriteResult } from "../../storage/capture/models.js";
import { createBackgroundWorker } from "../background-worker/index.js";
import type { BackgroundWorkerScope } from "../background-worker/models.js";
import { createLifecycleBridge } from "../lifecycle/index.js";
import type { LifecycleCaptureInput, LifecycleCaptureResult } from "../lifecycle/models.js";
import { createReconstructionWorker } from "../reconstruction/index.js";
import type { ReconstructionJobInput } from "../reconstruction/models.js";
import { lifecyclePassResult, reconstructionPassResult } from "./pass-results.js";
import { snapshotEngineOptions, snapshotSessionOptions } from "./options.js";
import type {
  TracingEngine,
  TracingEngineOptions,
  TracingEngineSession,
  TracingEngineSessionOptions,
} from "./models.js";

export function createTracingEngine(options: TracingEngineOptions): TracingEngine {
  const config = snapshotEngineOptions(options);
  return Object.freeze({
    forSession(sessionOptions: TracingEngineSessionOptions): TracingEngineSession {
      const session = snapshotSessionOptions(sessionOptions);
      let backgroundWorker: ReturnType<typeof createBackgroundWorker> | undefined;
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
      const scope: BackgroundWorkerScope = Object.freeze({
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
        reconstructPending: async () =>
          reconstructionPassResult(await reconstructionWorker.drain()),
        drainPending: async () => lifecyclePassResult(await lifecycleBridge.drain()),
      });
      return Object.freeze({
        async capture(input: LifecycleCaptureInput): Promise<LifecycleCaptureResult> {
          return lifecycleBridge.capture(input);
        },
        async queueReconstruction(input: ReconstructionJobInput): Promise<CaptureWriteResult> {
          const result = await reconstructionWorker.enqueue(input);
          if (result.status === "published" || result.status === "duplicate")
            await backgroundWorker?.wake();
          return result;
        },
        async wake() {
          return backgroundWorker!.wake();
        },
        async drain() {
          return backgroundWorker!.run();
        },
      });
    },
  });
}
