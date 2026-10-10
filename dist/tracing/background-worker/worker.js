import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tryAcquireFileLock, waitForFileLockClaim, withFileLock } from "../../storage/index.js";
import { ensurePrivateDirectory, publishExclusive, readPrivateFile, } from "../../storage/capture/utils/atomic-file.js";
import { identifierHash } from "../../storage/capture/paths.js";
import { FILE_LOCK_DIRECTORY_SUFFIX } from "../../storage/constants.js";
import { listPrivateDirectory } from "../../utils/files/private-directory.js";
import { BACKGROUND_WORKER_ACCOUNTS_DIRECTORY, BACKGROUND_WORKER_ACTIVE_MARKER_NAME, BACKGROUND_WORKER_ATTEMPT_NAME, BACKGROUND_WORKER_ATTEMPT_VERSION, BACKGROUND_WORKER_DEFAULT_MAX_ATTEMPTS, BACKGROUND_WORKER_DEFAULT_RETRY_DELAY_MS, BACKGROUND_WORKER_DIRECTORY, BACKGROUND_WORKER_INTEGRATIONS_DIRECTORY, BACKGROUND_WORKER_LAUNCH_LEASE_MS, BACKGROUND_WORKER_LAUNCHING_FILE, BACKGROUND_WORKER_LAUNCH_VERSION, BACKGROUND_WORKER_MARKER_ID_PATTERN, BACKGROUND_WORKER_MARKER_VERSION, BACKGROUND_WORKER_OWNER_WAIT_MS, BACKGROUND_WORKER_PENDING_FILE, BACKGROUND_WORKER_STARTUP_WAIT_MS, BACKGROUND_WORKER_STAGING_FILE, BACKGROUND_WORKER_LOCK_FILE, } from "./constants.js";
import { workerActivePath, workerAttemptPath, workerDirectory, workerLaunchPath, workerLockPath, workerPendingPath, } from "./paths.js";
export function createBackgroundWorker(options) {
    validateOptions(options);
    const storageRoot = resolve(options.storageRoot);
    const scope = Object.freeze({ ...options.scope });
    const retryPolicy = {
        maxAttempts: options.retryPolicy?.maxAttempts ?? BACKGROUND_WORKER_DEFAULT_MAX_ATTEMPTS,
        retryDelayMs: options.retryPolicy?.retryDelayMs ?? BACKGROUND_WORKER_DEFAULT_RETRY_DELAY_MS,
    };
    const config = { ...options, storageRoot, scope, retryPolicy };
    const directory = workerDirectory(storageRoot, scope);
    const lockPath = workerLockPath(storageRoot, scope);
    const directorySegments = [
        BACKGROUND_WORKER_DIRECTORY,
        BACKGROUND_WORKER_INTEGRATIONS_DIRECTORY,
        scope.integration,
        BACKGROUND_WORKER_ACCOUNTS_DIRECTORY,
        identifierHash(scope.accountFingerprint),
    ];
    return {
        async wake() {
            await ensurePrivateDirectory(storageRoot, directorySegments);
            const marker = makeMarker(randomUUID());
            await publishExclusive(workerPendingPath(storageRoot, scope), JSON.stringify(marker));
            const lock = await tryAcquireFileLock(lockPath);
            if (!lock)
                return "queued";
            try {
                const existingLaunch = await readLaunch(storageRoot, scope);
                if (existingLaunch &&
                    existingLaunch.expiresAtMs > Date.now() &&
                    (await processIsAlive(existingLaunch.pid))) {
                    return "queued";
                }
                if (existingLaunch)
                    await removeFile(workerLaunchPath(storageRoot, scope));
                const pid = await config.launchWorker();
                if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
                    throw new TypeError("Background worker launcher must return a child process ID");
                const createdAtMs = Date.now();
                const launch = {
                    version: BACKGROUND_WORKER_LAUNCH_VERSION,
                    pid,
                    createdAtMs,
                    expiresAtMs: createdAtMs + Math.max(BACKGROUND_WORKER_LAUNCH_LEASE_MS, config.startupWaitMs ?? 0),
                };
                if (!(await publishExclusive(workerLaunchPath(storageRoot, scope), JSON.stringify(launch)))) {
                    throw new Error("Background worker launch is already pending");
                }
                const claimed = await waitForFileLockClaim(lockPath, pid, {
                    timeoutMs: config.startupWaitMs ?? BACKGROUND_WORKER_STARTUP_WAIT_MS,
                });
                if (!claimed)
                    throw new Error("Background worker did not claim its lock before timeout");
                return "launched";
            }
            finally {
                await lock.release();
            }
        },
        async run() {
            await ensurePrivateDirectory(storageRoot, directorySegments);
            let processed = false;
            let retryExhausted = false;
            let failures = 0;
            for (;;) {
                const result = await withFileLock(lockPath, async () => {
                    for (;;) {
                        if (!(await matchesScope(config.resolveScope, scope)))
                            return "scope-mismatch";
                        const pass = await (async () => {
                            if (!(await matchesScope(config.resolveScope, scope)))
                                return {
                                    scopeMismatch: true,
                                    processed: false,
                                    retryExhausted: false,
                                    retryPending: false,
                                    retryAttempted: false,
                                };
                            await clearOwnedLaunch(storageRoot, scope);
                            return processLocked(storageRoot, directory, scope, config, retryPolicy);
                        })();
                        if (pass.scopeMismatch)
                            return "scope-mismatch";
                        processed ||= pass.processed;
                        retryExhausted ||= pass.retryExhausted;
                        if (pass.retryAttempted)
                            failures += 1;
                        if (failures >= retryPolicy.maxAttempts && pass.retryAttempted)
                            return "retry-exhausted";
                        if (pass.retryPending && retryPolicy.retryDelayMs > 0)
                            await delay(retryPolicy.retryDelayMs);
                        if (!(await hasPendingWork(storageRoot, directory)))
                            return retryExhausted ? "retry-exhausted" : processed ? "completed" : "idle";
                    }
                }, { timeoutMs: BACKGROUND_WORKER_OWNER_WAIT_MS });
                if (result === "scope-mismatch")
                    return result;
                if (failures >= retryPolicy.maxAttempts)
                    return "retry-exhausted";
                if (!(await hasPendingWork(storageRoot, directory)))
                    return result;
            }
        },
    };
}
function validateOptions(options) {
    const policy = options.retryPolicy;
    if (policy?.maxAttempts !== undefined &&
        (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1)) {
        throw new RangeError("Background worker max attempts must be a positive integer");
    }
    if (policy?.retryDelayMs !== undefined &&
        (!Number.isFinite(policy.retryDelayMs) || policy.retryDelayMs < 0)) {
        throw new RangeError("Background worker retry delay must be non-negative");
    }
    if (options.startupWaitMs !== undefined &&
        (!Number.isSafeInteger(options.startupWaitMs) || options.startupWaitMs <= 0)) {
        throw new RangeError("Background worker startup wait must be a positive integer");
    }
}
function makeMarker(id) {
    return { version: BACKGROUND_WORKER_MARKER_VERSION, id, sourcePid: process.pid };
}
async function matchesScope(resolveScope, expected) {
    const actual = await resolveScope();
    return (actual.integration === expected.integration &&
        actual.accountFingerprint === expected.accountFingerprint);
}
async function processLocked(storageRoot, directory, scope, options, retryPolicy) {
    const state = await readWorkerState(storageRoot, directory);
    for (const attempt of state.orphanedAttempts) {
        await removeFile(workerAttemptPath(storageRoot, scope, attempt.markerId, attempt.attempt));
    }
    let marker = state.active;
    if (!marker && state.pending) {
        marker = state.pending;
        if (!(await publishExclusive(workerActivePath(storageRoot, scope, marker.id), JSON.stringify(marker)))) {
            throw new Error("Background worker active marker already exists");
        }
        await removeFile(workerPendingPath(storageRoot, scope));
    }
    else if (marker && state.pending?.id === marker.id) {
        await removeFile(workerPendingPath(storageRoot, scope));
    }
    if (!marker)
        return {
            scopeMismatch: false,
            processed: false,
            retryExhausted: false,
            retryPending: false,
            retryAttempted: false,
        };
    let attempts = state.attempts;
    if (attempts.length >= retryPolicy.maxAttempts) {
        await removeActiveMarker(storageRoot, scope, marker, attempts);
        return {
            scopeMismatch: false,
            processed: true,
            retryExhausted: true,
            retryPending: false,
            retryAttempted: false,
        };
    }
    for (;;) {
        if (!(await matchesScope(options.resolveScope, scope)))
            return {
                scopeMismatch: true,
                processed: false,
                retryExhausted: false,
                retryPending: false,
                retryAttempted: false,
            };
        const result = await runTasks(options, scope);
        if (result === "scope-mismatch" || !(await matchesScope(options.resolveScope, scope)))
            return {
                scopeMismatch: true,
                processed: false,
                retryExhausted: false,
                retryPending: false,
                retryAttempted: false,
            };
        if (result === "progressed")
            continue;
        if (result === "idle") {
            await removeActiveMarker(storageRoot, scope, marker, attempts);
            return {
                scopeMismatch: false,
                processed: true,
                retryExhausted: false,
                retryPending: false,
                retryAttempted: false,
            };
        }
        const attemptNumber = attempts.length + 1;
        const attempt = {
            version: BACKGROUND_WORKER_ATTEMPT_VERSION,
            markerId: marker.id,
            attempt: attemptNumber,
        };
        if (!(await publishExclusive(workerAttemptPath(storageRoot, scope, marker.id, attemptNumber), JSON.stringify(attempt)))) {
            throw new Error("Background worker retry attempt already exists");
        }
        attempts = [...attempts, attempt];
        if (attempts.length >= retryPolicy.maxAttempts) {
            await removeActiveMarker(storageRoot, scope, marker, attempts);
            return {
                scopeMismatch: false,
                processed: true,
                retryExhausted: true,
                retryPending: false,
                retryAttempted: true,
            };
        }
        return {
            scopeMismatch: false,
            processed: true,
            retryExhausted: false,
            retryPending: true,
            retryAttempted: true,
        };
    }
}
async function runTasks(options, scope) {
    let progressed = false;
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
    return progressed ? "progressed" : "idle";
}
async function readWorkerState(storageRoot, directory) {
    const entries = await listPrivateDirectory(storageRoot, directory);
    let pending;
    let active;
    const attemptsByMarker = new Map();
    if (!entries)
        return { attempts: [], orphanedAttempts: [] };
    const claimsDirectory = `${BACKGROUND_WORKER_LOCK_FILE}${FILE_LOCK_DIRECTORY_SUFFIX}`;
    for (const entry of entries) {
        if (entry.name === claimsDirectory) {
            if (!entry.isDirectory() || entry.isSymbolicLink())
                throw new Error("Unsafe background worker lock directory");
            continue;
        }
        if (entry.name === BACKGROUND_WORKER_PENDING_FILE) {
            if (!entry.isFile() || entry.isSymbolicLink())
                throw new Error("Unsafe background worker pending marker");
            pending = parseMarker(await readRequired(storageRoot, join(directory, entry.name)));
            continue;
        }
        const activeMatch = BACKGROUND_WORKER_ACTIVE_MARKER_NAME.exec(entry.name);
        if (activeMatch) {
            if (!entry.isFile() || entry.isSymbolicLink())
                throw new Error("Unsafe background worker active marker");
            const markerId = activeMatch[1];
            if (markerId === undefined || !BACKGROUND_WORKER_MARKER_ID_PATTERN.test(markerId))
                throw new Error("Invalid background worker active path");
            if (active)
                throw new Error("Multiple background worker active markers");
            active = parseMarker(await readRequired(storageRoot, join(directory, entry.name)));
            if (active.id !== markerId)
                throw new Error("Background worker active marker path mismatch");
            continue;
        }
        const attemptMatch = BACKGROUND_WORKER_ATTEMPT_NAME.exec(entry.name);
        if (attemptMatch) {
            if (!entry.isFile() || entry.isSymbolicLink())
                throw new Error("Unsafe background worker retry attempt");
            const markerId = attemptMatch[1];
            const attemptNumber = Number(attemptMatch[2]);
            if (markerId === undefined ||
                !BACKGROUND_WORKER_MARKER_ID_PATTERN.test(markerId) ||
                !Number.isSafeInteger(attemptNumber)) {
                throw new Error("Invalid background worker attempt path");
            }
            const attempt = parseAttempt(await readRequired(storageRoot, join(directory, entry.name)), markerId, attemptNumber);
            const markerAttempts = attemptsByMarker.get(markerId) ?? [];
            markerAttempts.push(attempt);
            attemptsByMarker.set(markerId, markerAttempts);
            continue;
        }
        if (BACKGROUND_WORKER_STAGING_FILE.test(entry.name)) {
            if (!entry.isFile() || entry.isSymbolicLink())
                throw new Error("Unsafe background worker staging file");
            continue;
        }
        if (entry.name === BACKGROUND_WORKER_LAUNCHING_FILE) {
            if (!entry.isFile() || entry.isSymbolicLink())
                throw new Error("Unsafe background worker launch marker");
            continue;
        }
        throw new Error("Unexpected background worker state path");
    }
    const attempts = active ? (attemptsByMarker.get(active.id) ?? []) : [];
    attempts.sort((left, right) => left.attempt - right.attempt);
    for (let index = 0; index < attempts.length; index += 1) {
        if (attempts[index]?.attempt !== index + 1)
            throw new Error("Background worker retry sequence has a gap");
    }
    const orphanedAttempts = [...attemptsByMarker.entries()]
        .filter(([markerId]) => active?.id !== markerId)
        .flatMap(([, markerAttempts]) => markerAttempts);
    return {
        ...(pending ? { pending } : {}),
        ...(active ? { active } : {}),
        attempts,
        orphanedAttempts,
    };
}
async function hasPendingWork(storageRoot, directory) {
    const entries = await listPrivateDirectory(storageRoot, directory);
    return (entries?.some((entry) => entry.name === BACKGROUND_WORKER_PENDING_FILE ||
        BACKGROUND_WORKER_ACTIVE_MARKER_NAME.test(entry.name)) ?? false);
}
async function removeActiveMarker(storageRoot, scope, marker, attempts) {
    await removeFile(workerActivePath(storageRoot, scope, marker.id));
    for (const attempt of attempts)
        await removeFile(workerAttemptPath(storageRoot, scope, marker.id, attempt.attempt));
}
async function clearOwnedLaunch(storageRoot, scope) {
    const launch = await readLaunch(storageRoot, scope);
    if (launch?.pid === process.pid)
        await removeFile(workerLaunchPath(storageRoot, scope));
}
async function readLaunch(storageRoot, scope) {
    const contents = await readPrivateFile(storageRoot, workerLaunchPath(storageRoot, scope));
    if (contents === undefined)
        return undefined;
    const value = parseObject(contents);
    if (value.version !== BACKGROUND_WORKER_LAUNCH_VERSION ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        typeof value.createdAtMs !== "number" ||
        !Number.isSafeInteger(value.createdAtMs) ||
        typeof value.expiresAtMs !== "number" ||
        !Number.isSafeInteger(value.expiresAtMs) ||
        value.expiresAtMs <= value.createdAtMs) {
        throw new Error("Invalid background worker launch marker");
    }
    return value;
}
async function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        if (error.code === "ESRCH")
            return false;
        return true;
    }
}
async function readRequired(storageRoot, path) {
    const contents = await readPrivateFile(storageRoot, path);
    if (contents === undefined)
        throw new Error("Background worker state disappeared");
    return contents;
}
async function removeFile(path) {
    try {
        await unlink(path);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
function parseMarker(contents) {
    const value = parseObject(contents);
    if (value.version !== BACKGROUND_WORKER_MARKER_VERSION ||
        typeof value.id !== "string" ||
        !BACKGROUND_WORKER_MARKER_ID_PATTERN.test(value.id) ||
        typeof value.sourcePid !== "number" ||
        !Number.isSafeInteger(value.sourcePid) ||
        value.sourcePid <= 0) {
        throw new Error("Invalid background worker marker");
    }
    return value;
}
function parseAttempt(contents, markerId, attempt) {
    const value = parseObject(contents);
    if (value.version !== BACKGROUND_WORKER_ATTEMPT_VERSION ||
        value.markerId !== markerId ||
        value.attempt !== attempt) {
        throw new Error("Invalid background worker retry attempt");
    }
    return value;
}
function parseObject(contents) {
    const value = JSON.parse(contents);
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid background worker state");
    return value;
}
//# sourceMappingURL=worker.js.map