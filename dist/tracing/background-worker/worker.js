import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FileLockTimeoutError, processIsAlive, tryAcquireFileLock, waitForFileLockClaim, withFileLock, } from "../../storage/index.js";
import { removeEmptyLockFolders } from "../../storage/lock-folders.js";
import { removeFileIfPresent } from "../../utils/files/cleanup.js";
import { parseJsonObject } from "../../utils/validation/objects.js";
import { ensurePrivateDirectory, publishExclusive, readPrivateFile, } from "../../storage/capture/utils/atomic-file.js";
import { identifierHash, sessionSegments } from "../../storage/capture/paths.js";
import { listPrivateDirectory } from "../../utils/files/private-directory.js";
import { BACKGROUND_WORKER_ACTIVE_MARKER_ALREADY_EXISTS_MESSAGE, BACKGROUND_WORKER_ACTIVE_MARKER_NAME, BACKGROUND_WORKER_PENDING_FILE, BACKGROUND_WORKER_ATTEMPT_VERSION, BACKGROUND_WORKER_DEFAULT_MAX_ATTEMPTS, BACKGROUND_WORKER_DEFAULT_RETRY_DELAY_MS, BACKGROUND_WORKER_DID_NOT_CLAIM_ITS_LOCK_BEFORE_TIMEOUT_MESSAGE, BACKGROUND_WORKER_INVALID_LAUNCH_MARKER_MESSAGE, BACKGROUND_WORKER_LAUNCHER_MUST_RETURN_CHILD_PROCESS_ID_MESSAGE, BACKGROUND_WORKER_LAUNCH_IS_ALREADY_PENDING_MESSAGE, BACKGROUND_WORKER_LAUNCH_LEASE_MS, BACKGROUND_WORKER_LAUNCH_VERSION, BACKGROUND_WORKER_MARKER_VERSION, BACKGROUND_WORKER_MAX_ATTEMPTS_MUST_BE_POSITIVE_INTEGER_MESSAGE, BACKGROUND_WORKER_OWNER_WAIT_MS, BACKGROUND_WORKER_RETRY_ATTEMPT_ALREADY_EXISTS_MESSAGE, BACKGROUND_WORKER_RETRY_DELAY_MUST_BE_NON_NEGATIVE_MESSAGE, BACKGROUND_WORKER_STARTUP_WAIT_MS, BACKGROUND_WORKER_STARTUP_WAIT_MUST_BE_POSITIVE_INTEGER_MESSAGE, BACKGROUND_WORKER_STATE_ERROR, } from "./constants.js";
import { workerActivePath, scopedWorkerFileName, workerAttemptPath, workerDirectory, workerLaunchPath, workerLockPath, workerPendingPath, } from "./paths.js";
import { matchesScope } from "./utils/scope.js";
import { readWorkerState } from "./state.js";
export function createBackgroundWorker(options) {
    validateOptions(options);
    const context = createWorkerContext(options);
    return {
        wake: () => wakeWorker(context),
        async run() {
            try {
                return await runPasses(context);
            }
            finally {
                await removeEmptyLockFolders(context.lockPath, context.storageRoot);
            }
        },
    };
}
function createWorkerContext(options) {
    const storageRoot = resolve(options.storageRoot);
    const scope = Object.freeze({ ...options.scope });
    const retryPolicy = {
        maxAttempts: options.retryPolicy?.maxAttempts ?? BACKGROUND_WORKER_DEFAULT_MAX_ATTEMPTS,
        retryDelayMs: options.retryPolicy?.retryDelayMs ?? BACKGROUND_WORKER_DEFAULT_RETRY_DELAY_MS,
    };
    return {
        config: { ...options, storageRoot, scope, retryPolicy },
        storageRoot,
        scope,
        retryPolicy,
        directory: workerDirectory(storageRoot, scope),
        lockPath: workerLockPath(storageRoot, scope),
        directorySegments: sessionSegments(identifierHash(scope.sessionId)),
    };
}
async function wakeWorker(context) {
    const { storageRoot, scope, lockPath } = context;
    await ensurePrivateDirectory(storageRoot, context.directorySegments);
    const marker = makeMarker(randomUUID());
    await publishExclusive(workerPendingPath(storageRoot, scope), JSON.stringify(marker));
    const lock = await tryAcquireFileLock(lockPath);
    if (!lock)
        return "queued";
    try {
        return await launchWorker(context);
    }
    finally {
        await lock.release();
    }
}
async function launchWorker(context) {
    const { config, storageRoot, scope, lockPath } = context;
    const existingLaunch = await readLaunch(storageRoot, scope);
    if (existingLaunch &&
        existingLaunch.expiresAtMs > Date.now() &&
        processIsAlive(existingLaunch.pid) !== false) {
        return "queued";
    }
    if (existingLaunch)
        await removeFileIfPresent(workerLaunchPath(storageRoot, scope));
    const pid = await config.launchWorker();
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
        throw new TypeError(BACKGROUND_WORKER_LAUNCHER_MUST_RETURN_CHILD_PROCESS_ID_MESSAGE);
    const createdAtMs = Date.now();
    const launch = {
        version: BACKGROUND_WORKER_LAUNCH_VERSION,
        pid,
        createdAtMs,
        expiresAtMs: createdAtMs + Math.max(BACKGROUND_WORKER_LAUNCH_LEASE_MS, config.startupWaitMs ?? 0),
    };
    if (!(await publishExclusive(workerLaunchPath(storageRoot, scope), JSON.stringify(launch)))) {
        throw new Error(BACKGROUND_WORKER_LAUNCH_IS_ALREADY_PENDING_MESSAGE);
    }
    const claimed = await waitForFileLockClaim(lockPath, pid, {
        timeoutMs: config.startupWaitMs ?? BACKGROUND_WORKER_STARTUP_WAIT_MS,
    });
    if (!claimed)
        throw new Error(BACKGROUND_WORKER_DID_NOT_CLAIM_ITS_LOCK_BEFORE_TIMEOUT_MESSAGE);
    return "launched";
}
async function runPasses(context) {
    const { storageRoot, directory, lockPath, retryPolicy, scope } = context;
    await ensurePrivateDirectory(storageRoot, context.directorySegments);
    const totals = {
        processed: false,
        retryExhausted: false,
        failures: 0,
    };
    for (;;) {
        const result = await withOwnerLock(lockPath, () => runOwnedPasses(context, totals), {
            timeoutMs: BACKGROUND_WORKER_OWNER_WAIT_MS,
        });
        if (result === "scope-mismatch" || result === "deferred" || result === "busy")
            return result;
        if (totals.failures >= retryPolicy.maxAttempts)
            return "retry-exhausted";
        if (!(await hasPendingWork(storageRoot, directory, scope)))
            return result;
    }
}
async function passInScope(context) {
    const { config, storageRoot, scope } = context;
    if (!(await matchesScope(config.resolveScope, scope)))
        return lockedPass({ scopeMismatch: true });
    await clearOwnedLaunch(storageRoot, scope);
    return processLocked(storageRoot, context.directory, scope, config, context.retryPolicy);
}
async function runOwnedPasses(context, totals) {
    const { config, storageRoot, scope, directory, retryPolicy } = context;
    for (;;) {
        if (!(await matchesScope(config.resolveScope, scope)))
            return "scope-mismatch";
        const pass = await passInScope(context);
        if (pass.scopeMismatch)
            return "scope-mismatch";
        if (pass.deferred)
            return "deferred";
        totals.processed ||= pass.processed;
        totals.retryExhausted ||= pass.retryExhausted;
        if (pass.retryAttempted)
            totals.failures += 1;
        if (totals.failures >= retryPolicy.maxAttempts && pass.retryAttempted)
            return "retry-exhausted";
        if (pass.retryPending && retryPolicy.retryDelayMs > 0)
            await delay(retryPolicy.retryDelayMs);
        if (!(await hasPendingWork(storageRoot, directory, scope)))
            return totals.retryExhausted ? "retry-exhausted" : totals.processed ? "completed" : "idle";
    }
}
async function withOwnerLock(lockPath, callback, options) {
    try {
        return await withFileLock(lockPath, callback, options);
    }
    catch (error) {
        if (error instanceof FileLockTimeoutError)
            return "busy";
        throw error;
    }
}
function validateOptions(options) {
    const policy = options.retryPolicy;
    if (policy?.maxAttempts !== undefined &&
        (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1)) {
        throw new RangeError(BACKGROUND_WORKER_MAX_ATTEMPTS_MUST_BE_POSITIVE_INTEGER_MESSAGE);
    }
    if (policy?.retryDelayMs !== undefined &&
        (!Number.isFinite(policy.retryDelayMs) || policy.retryDelayMs < 0)) {
        throw new RangeError(BACKGROUND_WORKER_RETRY_DELAY_MUST_BE_NON_NEGATIVE_MESSAGE);
    }
    if (options.startupWaitMs !== undefined &&
        (!Number.isSafeInteger(options.startupWaitMs) || options.startupWaitMs <= 0)) {
        throw new RangeError(BACKGROUND_WORKER_STARTUP_WAIT_MUST_BE_POSITIVE_INTEGER_MESSAGE);
    }
}
function makeMarker(id) {
    return { version: BACKGROUND_WORKER_MARKER_VERSION, id, sourcePid: process.pid };
}
function lockedPass(overrides = {}) {
    return {
        scopeMismatch: false,
        processed: false,
        retryExhausted: false,
        retryPending: false,
        retryAttempted: false,
        deferred: false,
        ...overrides,
    };
}
async function claimMarker(storageRoot, scope, state) {
    const marker = state.active ?? state.pending;
    if (!state.active && state.pending) {
        if (!(await publishExclusive(workerActivePath(storageRoot, scope, state.pending.id), JSON.stringify(state.pending)))) {
            throw new Error(BACKGROUND_WORKER_ACTIVE_MARKER_ALREADY_EXISTS_MESSAGE);
        }
        await removeFileIfPresent(workerPendingPath(storageRoot, scope));
    }
    else if (marker && state.pending?.id === marker.id) {
        await removeFileIfPresent(workerPendingPath(storageRoot, scope));
    }
    return marker;
}
async function recordAttempt(storageRoot, scope, marker, attemptNumber) {
    const attempt = {
        version: BACKGROUND_WORKER_ATTEMPT_VERSION,
        markerId: marker.id,
        attempt: attemptNumber,
    };
    if (!(await publishExclusive(workerAttemptPath(storageRoot, scope, marker.id, attemptNumber), JSON.stringify(attempt)))) {
        throw new Error(BACKGROUND_WORKER_RETRY_ATTEMPT_ALREADY_EXISTS_MESSAGE);
    }
    return attempt;
}
async function processLocked(storageRoot, directory, scope, options, retryPolicy) {
    const state = await readWorkerState(storageRoot, directory, scope);
    for (const attempt of state.orphanedAttempts) {
        await removeFileIfPresent(workerAttemptPath(storageRoot, scope, attempt.markerId, attempt.attempt));
    }
    const marker = await claimMarker(storageRoot, scope, state);
    if (!marker)
        return lockedPass();
    let attempts = state.attempts;
    if (attempts.length >= retryPolicy.maxAttempts) {
        await removeActiveMarker(storageRoot, scope, marker, attempts);
        return lockedPass({ processed: true, retryExhausted: true });
    }
    for (;;) {
        if (!(await matchesScope(options.resolveScope, scope)))
            return lockedPass({ scopeMismatch: true });
        const result = await runTasks(options, scope);
        if (result === "scope-mismatch" || !(await matchesScope(options.resolveScope, scope)))
            return lockedPass({ scopeMismatch: true });
        if (result === "progressed")
            continue;
        if (result === "idle" || result === "deferred") {
            if (result === "idle")
                await removeActiveMarker(storageRoot, scope, marker, attempts);
            return lockedPass({ processed: true, deferred: result === "deferred" });
        }
        attempts = [...attempts, await recordAttempt(storageRoot, scope, marker, attempts.length + 1)];
        if (attempts.length >= retryPolicy.maxAttempts) {
            await removeActiveMarker(storageRoot, scope, marker, attempts);
            return lockedPass({ processed: true, retryExhausted: true, retryAttempted: true });
        }
        return lockedPass({ processed: true, retryPending: true, retryAttempted: true });
    }
}
async function runTasks(options, scope) {
    let progressed = false;
    let deferred = false;
    if (options.reconstructPending) {
        let result;
        try {
            result = await options.reconstructPending();
        }
        catch {
            return "retryable-failure";
        }
        if (!(await matchesScope(options.resolveScope, scope)))
            return "scope-mismatch";
        if (result === "retryable-failure")
            return result;
        progressed ||= result === "progressed";
        deferred ||= result === "deferred";
    }
    let result;
    try {
        result = await options.drainPending();
    }
    catch {
        return "retryable-failure";
    }
    if (result === "retryable-failure")
        return result;
    progressed ||= result === "progressed";
    deferred ||= result === "deferred";
    return deferred ? "deferred" : progressed ? "progressed" : "idle";
}
async function hasPendingWork(storageRoot, directory, scope) {
    const entries = await listPrivateDirectory(storageRoot, directory);
    return (entries?.some((entry) => {
        const name = scopedWorkerFileName(scope, entry.name);
        return (name === BACKGROUND_WORKER_PENDING_FILE ||
            BACKGROUND_WORKER_ACTIVE_MARKER_NAME.test(name ?? ""));
    }) ?? false);
}
async function removeActiveMarker(storageRoot, scope, marker, attempts) {
    await removeFileIfPresent(workerActivePath(storageRoot, scope, marker.id));
    for (const attempt of attempts)
        await removeFileIfPresent(workerAttemptPath(storageRoot, scope, marker.id, attempt.attempt));
}
async function clearOwnedLaunch(storageRoot, scope) {
    const launch = await readLaunch(storageRoot, scope);
    if (launch?.pid === process.pid)
        await removeFileIfPresent(workerLaunchPath(storageRoot, scope));
}
async function readLaunch(storageRoot, scope) {
    const contents = await readPrivateFile(storageRoot, workerLaunchPath(storageRoot, scope));
    if (contents === undefined)
        return undefined;
    const value = parseJsonObject(contents, BACKGROUND_WORKER_STATE_ERROR);
    if (value.version !== BACKGROUND_WORKER_LAUNCH_VERSION ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        typeof value.createdAtMs !== "number" ||
        !Number.isSafeInteger(value.createdAtMs) ||
        typeof value.expiresAtMs !== "number" ||
        !Number.isSafeInteger(value.expiresAtMs) ||
        value.expiresAtMs <= value.createdAtMs) {
        throw new Error(BACKGROUND_WORKER_INVALID_LAUNCH_MARKER_MESSAGE);
    }
    return value;
}
//# sourceMappingURL=worker.js.map