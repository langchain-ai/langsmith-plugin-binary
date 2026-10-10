import { unlink } from "node:fs/promises";
import { ensurePrivateDirectory, publishExclusive, readPrivateFile, } from "../../storage/capture/utils/atomic-file.js";
import { withFileLock } from "../../storage/file-lock.js";
import { describe } from "../../utils/errors.js";
import { TRACING_ENGINE_BACKGROUND_RECOVERY_COOLDOWN_MS, TRACING_ENGINE_BACKGROUND_RECOVERY_FILE_NOT_FOUND_CODE, TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_EXISTS_ERROR, TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_VERSION, TRACING_ENGINE_BACKGROUND_RECOVERY_RETRY_RANGE_ERROR, TRACING_ENGINE_FOREIGN_SESSION_MIN_AGE_MS, } from "./constants.js";
import { recoverTracingSessions } from "./recovery.js";
import { backgroundRecoveryPathSegments, backgroundRecoveryPaths } from "./recovery-paths.js";
export async function runBackgroundRecovery(runtime, options) {
    const cooldownMs = options.cooldownMs ?? TRACING_ENGINE_BACKGROUND_RECOVERY_COOLDOWN_MS;
    const minimumForeignAgeMs = options.minimumForeignAgeMs ?? TRACING_ENGINE_FOREIGN_SESSION_MIN_AGE_MS;
    const paths = backgroundRecoveryPaths(runtime.storageRoot, runtime);
    let retryAtMs;
    try {
        await ensurePrivateDirectory(runtime.storageRoot, backgroundRecoveryPathSegments(runtime));
        const observedMarker = await readMarker(runtime.storageRoot, paths.marker);
        if (observedMarker && observedMarker.retryAtMs > Date.now())
            return { status: "cooldown", retryAtMs: observedMarker.retryAtMs };
        return await withFileLock(paths.lock, async () => {
            const now = Date.now();
            const existing = await readMarker(runtime.storageRoot, paths.marker);
            if (existing && existing.retryAtMs > now)
                return { status: "cooldown", retryAtMs: existing.retryAtMs };
            retryAtMs = now + cooldownMs;
            if (!Number.isSafeInteger(retryAtMs))
                throw new RangeError(TRACING_ENGINE_BACKGROUND_RECOVERY_RETRY_RANGE_ERROR);
            await writeMarker(paths.marker, {
                version: TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_VERSION,
                retryAtMs,
            });
            try {
                const report = await recoverTracingSessions(runtime, {
                    optionsForSession: options.optionsForSession,
                    minimumForeignAgeMs,
                    now,
                    excludeCurrentSession: true,
                });
                retryAtMs = nextRetryAt(cooldownMs);
                await writeMarker(paths.marker, {
                    version: TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_VERSION,
                    retryAtMs,
                });
                return report.failed.length === 0
                    ? { status: "completed", report, retryAtMs }
                    : { status: "partial", report, retryAtMs, retryable: true };
            }
            catch (error) {
                retryAtMs = nextRetryAt(cooldownMs);
                await writeMarker(paths.marker, {
                    version: TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_VERSION,
                    retryAtMs,
                });
                return {
                    status: "failed",
                    message: describe(error),
                    retryable: true,
                    retryAtMs,
                };
            }
        });
    }
    catch (error) {
        return {
            status: "failed",
            message: describe(error),
            retryable: true,
            ...(retryAtMs === undefined ? {} : { retryAtMs }),
        };
    }
}
function nextRetryAt(cooldownMs) {
    const retryAtMs = Date.now() + cooldownMs;
    if (!Number.isSafeInteger(retryAtMs))
        throw new RangeError(TRACING_ENGINE_BACKGROUND_RECOVERY_RETRY_RANGE_ERROR);
    return retryAtMs;
}
async function readMarker(root, path) {
    const contents = await readPrivateFile(root, path);
    if (contents === undefined)
        return undefined;
    try {
        const value = JSON.parse(contents);
        if (typeof value === "object" &&
            value !== null &&
            "version" in value &&
            value.version === TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_VERSION &&
            "retryAtMs" in value &&
            typeof value.retryAtMs === "number" &&
            Number.isSafeInteger(value.retryAtMs) &&
            value.retryAtMs >= 0) {
            return value;
        }
    }
    catch { }
    return undefined;
}
async function writeMarker(path, marker) {
    try {
        await unlink(path);
    }
    catch (error) {
        if (error.code !==
            TRACING_ENGINE_BACKGROUND_RECOVERY_FILE_NOT_FOUND_CODE)
            throw error;
    }
    if (!(await publishExclusive(path, JSON.stringify(marker))))
        throw new Error(TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_EXISTS_ERROR);
}
//# sourceMappingURL=background-recovery.js.map