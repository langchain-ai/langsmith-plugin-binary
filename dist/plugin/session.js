import { createCaptureStore } from "../storage/capture/index.js";
import { createTracingEngine } from "../tracing/engine/index.js";
import { resolveUploadDestinationFingerprint } from "../tracing/upload/identity.js";
import { UNAVAILABLE_ACCOUNT_FINGERPRINT } from "./constants.js";
export function openPluginSession(options) {
    const { storageRoot, integration, sessionId, writer } = options;
    const callbacks = (id) => ({
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
function fingerprintOf(writer) {
    if (writer === undefined)
        return UNAVAILABLE_ACCOUNT_FINGERPRINT;
    try {
        return resolveUploadDestinationFingerprint(writer);
    }
    catch {
        return UNAVAILABLE_ACCOUNT_FINGERPRINT;
    }
}
//# sourceMappingURL=session.js.map