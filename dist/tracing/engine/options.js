import { resolve } from "node:path";
import { TRACING_ENGINE_BACKGROUND_RECOVERY_MINIMUM_AGE_ERROR, TRACING_ENGINE_BACKGROUND_RECOVERY_REPORT_CALLBACK_ERROR, TRACING_ENGINE_BACKGROUND_RECOVERY_SESSION_CALLBACK_ERROR, TRACING_ENGINE_STORAGE_ROOT_REQUIRED_MESSAGE, } from "./constants.js";
export function snapshotEngineOptions(options) {
    if (typeof options.storageRoot !== "string" || options.storageRoot.trim() === "")
        throw new TypeError(TRACING_ENGINE_STORAGE_ROOT_REQUIRED_MESSAGE);
    return Object.freeze({
        ...options,
        storageRoot: resolve(options.storageRoot),
        writer: snapshotWriterOptions(options.writer),
    });
}
export function snapshotSessionOptions(options) {
    if (options.backgroundRecovery !== undefined) {
        if (typeof options.backgroundRecovery.optionsForSession !== "function")
            throw new TypeError(TRACING_ENGINE_BACKGROUND_RECOVERY_SESSION_CALLBACK_ERROR);
        if (typeof options.backgroundRecovery.onReport !== "function")
            throw new TypeError(TRACING_ENGINE_BACKGROUND_RECOVERY_REPORT_CALLBACK_ERROR);
        if (options.backgroundRecovery.minimumForeignAgeMs !== undefined &&
            (!Number.isSafeInteger(options.backgroundRecovery.minimumForeignAgeMs) ||
                options.backgroundRecovery.minimumForeignAgeMs < 0)) {
            throw new RangeError(TRACING_ENGINE_BACKGROUND_RECOVERY_MINIMUM_AGE_ERROR);
        }
    }
    return Object.freeze({
        ...options,
        ...(options.backgroundRecovery === undefined
            ? {}
            : { backgroundRecovery: Object.freeze({ ...options.backgroundRecovery }) }),
    });
}
function snapshotWriterOptions(options) {
    return Object.freeze({
        ...options,
        destinations: Object.freeze(options.destinations.map((destination) => Object.freeze({ ...destination }))),
        ...(options.replicas === undefined
            ? {}
            : {
                replicas: Object.freeze(options.replicas.map((replica) => Object.freeze({
                    ...replica,
                    ...(replica.updates === undefined
                        ? {}
                        : { updates: structuredClone(replica.updates) }),
                }))),
            }),
        ...(options.redactExtraRules === undefined
            ? {}
            : {
                redactExtraRules: Object.freeze(options.redactExtraRules.map((rule) => Object.freeze({ ...rule }))),
            }),
    });
}
//# sourceMappingURL=options.js.map