import type { CaptureWriteResult } from "../../storage/capture/models.js";
import { createBackgroundWorker } from "../background-worker/index.js";
import { matchesScope } from "../background-worker/utils/scope.js";
import type { BackgroundWorkerScope } from "../background-worker/models.js";
import { createLifecycleBridge } from "../lifecycle/index.js";
import type {
  LifecycleCaptureInput,
  LifecycleCaptureResult,
  LifecycleSnapshotCaptureInput,
} from "../lifecycle/models.js";
import { createReconstructionWorker } from "../reconstruction/index.js";
import { wakeCapturedWork } from "../capture-wake.js";
import type { ReconstructionJobInput } from "../reconstruction/models.js";
import { describe } from "../../utils/errors.js";
import { lifecyclePassResult, reconstructionPassResult } from "./pass-results.js";
import { snapshotEngineOptions, snapshotSessionOptions } from "./options.js";
import { recoverTracingSessions } from "./recovery.js";
import { runBackgroundRecovery } from "./background-recovery.js";
import { TRACING_ENGINE_BACKGROUND_RECOVERY_REPORT_ERROR } from "./constants.js";
import type {
  TracingEngine,
  TracingEngineOptions,
  TracingEngineBackgroundRecoveryResult,
  TracingEngineRecoveryOptions,
  TracingEngineRecoveryRuntime,
  TracingEngineSession,
  TracingEngineSessionOptions,
} from "./models.js";

export function createTracingEngine(options: TracingEngineOptions): TracingEngine {
  const config = snapshotEngineOptions(options);

  function forSession(sessionOptions: TracingEngineSessionOptions): TracingEngineSession {
    return createSession(snapshotSessionOptions(sessionOptions));
  }

  function createSession(session: TracingEngineSessionOptions): TracingEngineSession {
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
      reconstructPending: async () => reconstructionPassResult(await reconstructionWorker.drain()),
      drainPending: async () => lifecyclePassResult(await lifecycleBridge.drain()),
    });
    const recoveryRuntime = (): TracingEngineRecoveryRuntime => ({
      storageRoot: config.storageRoot,
      integration: config.integration,
      accountFingerprint: lifecycleBridge.accountFingerprint,
      writer: config.writer,
      currentSessionId: session.sessionId,
      wakeCurrent: () => backgroundWorker!.wake(),
      createSession: (recoveredOptions) =>
        createSession(
          snapshotSessionOptions({
            ...recoveredOptions,
            ...(session.backgroundRecovery === undefined
              ? {}
              : { backgroundRecovery: session.backgroundRecovery }),
          }),
        ),
    });
    return Object.freeze({
      async capture(input: LifecycleCaptureInput): Promise<LifecycleCaptureResult> {
        return lifecycleBridge.capture(input);
      },
      async captureSnapshot(input: LifecycleSnapshotCaptureInput): Promise<LifecycleCaptureResult> {
        return lifecycleBridge.captureSnapshot(input);
      },
      async queueReconstruction(input: ReconstructionJobInput): Promise<CaptureWriteResult> {
        const result = await reconstructionWorker.enqueue(input);
        if (result.status === "published" || result.status === "duplicate")
          await wakeCapturedWork(result, () => backgroundWorker?.wake());
        return result;
      },
      async readSavedReconstructionWake(error: unknown, input: ReconstructionJobInput) {
        return reconstructionWorker.readSavedWake(error, input);
      },
      async wake() {
        return backgroundWorker!.wake();
      },
      async drain() {
        const result = await backgroundWorker!.run();
        const backgroundRecovery = session.backgroundRecovery;
        if (backgroundRecovery && (result === "completed" || result === "idle")) {
          let recoveryResult: TracingEngineBackgroundRecoveryResult;
          const checkScope = () => matchesScope(() => session.resolveScope(scope), scope);
          try {
            recoveryResult = (await checkScope())
              ? await runBackgroundRecovery(recoveryRuntime(), backgroundRecovery, checkScope)
              : { status: "scope-mismatch" };
          } catch (error) {
            recoveryResult = {
              status: "failed",
              message: describe(error),
              retryable: true,
            };
          }
          try {
            await backgroundRecovery.onReport(recoveryResult);
          } catch (error) {
            console.error(TRACING_ENGINE_BACKGROUND_RECOVERY_REPORT_ERROR, describe(error));
          }
        }
        return result;
      },
      async recoverSessions(request: TracingEngineRecoveryOptions) {
        return recoverTracingSessions(recoveryRuntime(), request);
      },
    });
  }

  return Object.freeze({ forSession });
}
