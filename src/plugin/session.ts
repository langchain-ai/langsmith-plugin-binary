import { createCaptureStore } from "../storage/capture/index.js";
import { createTracingEngine } from "../tracing/engine/index.js";
import type { TracingEngineSessionCallbacks } from "../tracing/engine/models.js";
import { resolveUploadDestinationFingerprint } from "../tracing/upload/identity.js";
import type { LangSmithUploadWriterOptions } from "../tracing/upload/models.js";
import { UNAVAILABLE_ACCOUNT_FINGERPRINT } from "./constants.js";
import type { PluginSession, PluginSessionOptions } from "./models.js";

export function openPluginSession(options: PluginSessionOptions): PluginSession {
  const { storageRoot, integration, sessionId, writer } = options;
  const callbacks = (id: string): TracingEngineSessionCallbacks => ({
    reconstruct: options.reconstruct,
    scheduleWake: () => options.scheduleWake(id),
    resolveScope: async (expected) => ({
      ...expected,
      accountFingerprint: fingerprintOf(await options.currentWriter()),
    }),
  });
  const session = createTracingEngine({ storageRoot, integration, writer }).forSession({
    sessionId,
    ...callbacks(sessionId),
    ...(options.startupWaitMs === undefined ? {} : { startupWaitMs: options.startupWaitMs }),
    ...(options.onRecoveryReport === undefined
      ? {}
      : {
          backgroundRecovery: {
            optionsForSession: callbacks,
            onReport: options.onRecoveryReport,
          },
        }),
  });
  return {
    session,
    sessionId,
    store: createCaptureStore(storageRoot),
    fingerprint: resolveUploadDestinationFingerprint(writer),
    callbacks,
  };
}

function fingerprintOf(writer: LangSmithUploadWriterOptions | undefined): string {
  if (writer === undefined) return UNAVAILABLE_ACCOUNT_FINGERPRINT;
  try {
    return resolveUploadDestinationFingerprint(writer);
  } catch {
    return UNAVAILABLE_ACCOUNT_FINGERPRINT;
  }
}
