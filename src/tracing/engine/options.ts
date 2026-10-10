import { resolve } from "node:path";
import type { DeliveryPolicy } from "../delivery/models.js";
import type { LangSmithUploadWriterOptions } from "../upload/models.js";
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
  return Object.freeze({
    ...options,
    ...(options.retryPolicy === undefined
      ? {}
      : { retryPolicy: Object.freeze({ ...options.retryPolicy }) }),
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
