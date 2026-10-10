import { resolve } from "node:path";
import type { DeliveryPolicy } from "../delivery/models.js";
import type { LangSmithUploadWriterOptions } from "../upload/models.js";
import {
  TRACING_ENGINE_BACKGROUND_RECOVERY_COOLDOWN_RANGE_ERROR,
  TRACING_ENGINE_BACKGROUND_RECOVERY_MINIMUM_AGE_ERROR,
  TRACING_ENGINE_BACKGROUND_RECOVERY_REPORT_CALLBACK_ERROR,
  TRACING_ENGINE_BACKGROUND_RECOVERY_SESSION_CALLBACK_ERROR,
} from "./constants.js";
import type { TracingEngineOptions, TracingEngineSessionOptions } from "./models.js";

export function snapshotEngineOptions(options: TracingEngineOptions): TracingEngineOptions {
  return Object.freeze({
    ...options,
    storageRoot: resolve(options.storageRoot),
    writer: snapshotWriterOptions(options.writer),
    ...(options.policy === undefined ? {} : { policy: snapshotPolicy(options.policy) }),
  });
}

export function snapshotSessionOptions(
  options: TracingEngineSessionOptions,
): TracingEngineSessionOptions {
  if (options.backgroundRecovery !== undefined) {
    if (typeof options.backgroundRecovery.optionsForSession !== "function")
      throw new TypeError(TRACING_ENGINE_BACKGROUND_RECOVERY_SESSION_CALLBACK_ERROR);
    if (typeof options.backgroundRecovery.onReport !== "function")
      throw new TypeError(TRACING_ENGINE_BACKGROUND_RECOVERY_REPORT_CALLBACK_ERROR);
    if (
      options.backgroundRecovery.minimumForeignAgeMs !== undefined &&
      (!Number.isSafeInteger(options.backgroundRecovery.minimumForeignAgeMs) ||
        options.backgroundRecovery.minimumForeignAgeMs < 0)
    ) {
      throw new RangeError(TRACING_ENGINE_BACKGROUND_RECOVERY_MINIMUM_AGE_ERROR);
    }
    if (
      options.backgroundRecovery.cooldownMs !== undefined &&
      (!Number.isSafeInteger(options.backgroundRecovery.cooldownMs) ||
        options.backgroundRecovery.cooldownMs < 1)
    ) {
      throw new RangeError(TRACING_ENGINE_BACKGROUND_RECOVERY_COOLDOWN_RANGE_ERROR);
    }
  }
  return Object.freeze({
    ...options,
    ...(options.retryPolicy === undefined
      ? {}
      : { retryPolicy: Object.freeze({ ...options.retryPolicy }) }),
    ...(options.backgroundRecovery === undefined
      ? {}
      : { backgroundRecovery: Object.freeze({ ...options.backgroundRecovery }) }),
  });
}

function snapshotWriterOptions(
  options: LangSmithUploadWriterOptions,
): LangSmithUploadWriterOptions {
  return Object.freeze({
    ...options,
    destinations: Object.freeze(
      options.destinations.map((destination) => Object.freeze({ ...destination })),
    ),
    ...(options.replicas === undefined
      ? {}
      : {
          replicas: Object.freeze(
            options.replicas.map((replica) =>
              Object.freeze({
                ...replica,
                ...(replica.updates === undefined
                  ? {}
                  : { updates: structuredClone(replica.updates) }),
              }),
            ),
          ),
        }),
    ...(options.redactExtraRules === undefined
      ? {}
      : {
          redactExtraRules: Object.freeze(
            options.redactExtraRules.map((rule) => Object.freeze({ ...rule })),
          ),
        }),
  });
}

function snapshotPolicy(policy: Partial<DeliveryPolicy>): Partial<DeliveryPolicy> {
  return Object.freeze({ ...policy });
}
