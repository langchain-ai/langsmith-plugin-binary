import type { CaptureWriteResult } from "../../storage/capture/models.js";
import { createBackgroundWorker } from "../background-worker/index.js";
import { matchesScope } from "../background-worker/utils/scope.js";
import type { BackgroundWorker, BackgroundWorkerScope } from "../background-worker/models.js";
import { createLifecycleBridge } from "../lifecycle/index.js";
import type { LifecycleCaptureInput, LifecycleCaptureResult } from "../lifecycle/models.js";
import { createReconstructionWorker } from "../reconstruction/index.js";
import { wakeCapturedWork } from "../capture-wake.js";
import type { ReconstructionJobInput } from "../reconstruction/models.js";
import { describe } from "../../utils/errors.js";
import { lifecyclePassResult, reconstructionPassResult } from "./pass-results.js";
import { snapshotEngineOptions, snapshotSessionOptions } from "./options.js";
import { recoverTracingSessions } from "./recovery.js";
import { runBackgroundRecovery } from "./background-recovery.js";
import { TRACING_ENGINE_BACKGROUND_RECOVERY_REPORT_ERROR } from "./constants.js";
import { drainThroughBackoff } from "./retry-wait.js";
import type {
  TracingEngine,
  TracingEngineOptions,
  TracingEngineBackgroundRecoveryResult,
  TracingEngineRecoveryOptions,
  TracingEngineRecoveryRuntime,
  TracingEngineSession,
  TracingEngineSessionContext,
  TracingEngineSessionOptions,
  TracingEngineSessionState,
} from "./models.js";

export function createTracingEngine(options: TracingEngineOptions): TracingEngine {
  const config = snapshotEngineOptions(options);
  const forSession = (sessionOptions: TracingEngineSessionOptions): TracingEngineSession =>
    createSession(config, snapshotSessionOptions(sessionOptions));
  return Object.freeze({ forSession });
}

function createSession(
  config: TracingEngineOptions,
  session: TracingEngineSessionOptions,
): TracingEngineSession {
  const state: TracingEngineSessionState = { droppedWork: false };
  const lifecycleBridge = createLifecycleBridge({
    storageRoot: config.storageRoot,
    integration: config.integration,
    sessionId: session.sessionId,
    writer: config.writer,
    wake: async () => state.backgroundWorker?.wake(),
  });
  const reconstructionWorker = createReconstructionWorker({
    storageRoot: config.storageRoot,
    integration: config.integration,
    sessionId: session.sessionId,
    bridge: lifecycleBridge,
    reconstruct: session.reconstruct,
  });
  const scope: BackgroundWorkerScope = Object.freeze({
    integration: config.integration,
    sessionId: session.sessionId,
    accountFingerprint: lifecycleBridge.accountFingerprint,
  });
  const context: TracingEngineSessionContext = {
    config,
    session,
    scope,
    lifecycleBridge,
    reconstructionWorker,
    state,
  };
  state.backgroundWorker = createSessionWorker(context);
  return Object.freeze({
    async capture(input: LifecycleCaptureInput): Promise<LifecycleCaptureResult> {
      return lifecycleBridge.capture(input);
    },
    async wake() {
      return state.backgroundWorker!.wake();
    },
    async queueReconstruction(input: ReconstructionJobInput): Promise<CaptureWriteResult> {
      const result = await reconstructionWorker.enqueue(input);
      if (result.status === "published" || result.status === "duplicate")
        await wakeCapturedWork(result, () => state.backgroundWorker?.wake());
      return result;
    },
    async readSavedReconstructionWake(error: unknown, input: ReconstructionJobInput) {
      return reconstructionWorker.readSavedWake(error, input);
    },
    drain: () => drainSession(context),
    async recoverSessions(request: TracingEngineRecoveryOptions) {
      return recoverTracingSessions(recoveryRuntime(context), request);
    },
  });
}

function createSessionWorker(context: TracingEngineSessionContext): BackgroundWorker {
  const { config, session, scope, lifecycleBridge, reconstructionWorker, state } = context;
  return createBackgroundWorker({
    storageRoot: config.storageRoot,
    scope,
    resolveScope: () => session.resolveScope(scope),
    launchWorker: session.scheduleWake,
    ...(session.startupWaitMs === undefined ? {} : { startupWaitMs: session.startupWaitMs }),
    reconstructPending: async () => {
      const result = await drainThroughBackoff(() => reconstructionWorker.drain());
      state.droppedWork ||= result.status === "drained" && result.dropped > 0;
      return reconstructionPassResult(result);
    },
    drainPending: async () => {
      const result = await drainThroughBackoff(() => lifecycleBridge.drain());
      state.droppedWork ||= result.status === "drained" && result.dropped > 0;
      return lifecyclePassResult(result);
    },
  });
}

function recoveryRuntime(context: TracingEngineSessionContext): TracingEngineRecoveryRuntime {
  const { config, session, lifecycleBridge, state } = context;
  return {
    storageRoot: config.storageRoot,
    integration: config.integration,
    accountFingerprint: lifecycleBridge.accountFingerprint,
    writer: config.writer,
    currentSessionId: session.sessionId,
    wakeCurrent: () => state.backgroundWorker!.wake(),
    createSession: (recoveredOptions) =>
      createSession(
        config,
        snapshotSessionOptions({
          ...recoveredOptions,
          ...(session.backgroundRecovery === undefined
            ? {}
            : { backgroundRecovery: session.backgroundRecovery }),
        }),
      ),
  };
}

async function reportBackgroundRecovery(
  context: TracingEngineSessionContext,
  backgroundRecovery: NonNullable<TracingEngineSessionOptions["backgroundRecovery"]>,
): Promise<void> {
  const { session, scope } = context;
  let recoveryResult: TracingEngineBackgroundRecoveryResult;
  const checkScope = () => matchesScope(() => session.resolveScope(scope), scope);
  try {
    recoveryResult = (await checkScope())
      ? await runBackgroundRecovery(recoveryRuntime(context), backgroundRecovery, checkScope)
      : { status: "scope-mismatch" };
  } catch (error) {
    recoveryResult = { status: "failed", message: describe(error), retryable: true };
  }
  try {
    await backgroundRecovery.onReport(recoveryResult);
  } catch (error) {
    console.error(TRACING_ENGINE_BACKGROUND_RECOVERY_REPORT_ERROR, describe(error));
  }
}

async function drainSession(context: TracingEngineSessionContext) {
  const { session, state } = context;
  state.droppedWork = false;
  const run = await state.backgroundWorker!.run();
  const result =
    state.droppedWork && (run === "completed" || run === "idle" || run === "deferred")
      ? "dropped"
      : run;
  const backgroundRecovery = session.backgroundRecovery;
  if (backgroundRecovery && (run === "completed" || run === "idle"))
    await reportBackgroundRecovery(context, backgroundRecovery);
  return result;
}
