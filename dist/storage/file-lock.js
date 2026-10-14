import { chmod, link, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isPlainRecord } from "../utils/validation/objects.js";
import { FILE_LOCK_ACQUIRE_MESSAGE, FILE_LOCK_COMPATIBLE_ACQUIRE_CLEANUP_MESSAGE, FILE_LOCK_COMPATIBLE_RELEASE_MESSAGE, FILE_LOCK_CLAIM_VERSION, FILE_LOCK_CLAIM_EXTENSION, FILE_LOCK_DIRECTORY_MODE, FILE_LOCK_DIRECTORY_SUFFIX, FILE_LOCK_ENCODING, FILE_LOCK_EXCLUSIVE_FLAG, FILE_LOCK_FILE_MODE, FILE_LOCK_NEGATIVE_TICKET_LIMIT, FILE_LOCK_POLL_INTERVAL_MS, FILE_LOCK_RELEASE_MESSAGE, FILE_LOCK_RENAME_RETRY_TIMEOUT_MS, FILE_LOCK_STALE_CLAIM_MS, FILE_LOCK_TEMP_PREFIX, FILE_LOCK_TEMP_SUFFIX, FILE_LOCK_TICKET_LIMIT_MESSAGE, FILE_LOCK_TRY_CHOOSING_WAIT_MS, FILE_LOCK_UNSAFE_DIRECTORY_MESSAGE, FILE_LOCK_UNSELECTED_TICKET, } from "./constants.js";
import { errorCode } from "../utils/errors.js";
import { FileLockTimeoutError } from "./errors.js";
import { FILE_EXISTS_CODE, FILE_MISSING_CODE, PERMISSION_DENIED_CODE } from "../utils/constants.js";
import { startHeartbeat, stopHeartbeat } from "./file-lock-heartbeat.js";
import { acquireLegacyDirectoryGate, releaseLegacyDirectoryGate } from "./legacy-gate.js";
import { isBusyFileError, processIsAlive, removeFile, timeoutMs, waitForNextScan, } from "./file-lock-support.js";
function parseClaim(value, id) {
    if (!isPlainRecord(value))
        return undefined;
    if (value.version !== FILE_LOCK_CLAIM_VERSION ||
        value.id !== id ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        typeof value.choosing !== "boolean" ||
        typeof value.ticket !== "number" ||
        !Number.isSafeInteger(value.ticket) ||
        value.ticket < FILE_LOCK_NEGATIVE_TICKET_LIMIT ||
        (value.choosing
            ? value.ticket !== FILE_LOCK_UNSELECTED_TICKET
            : value.ticket === FILE_LOCK_UNSELECTED_TICKET)) {
        return undefined;
    }
    return value;
}
async function publishClaim(filePath, claim, create, deadline) {
    const temporaryPath = join(dirname(filePath), `${FILE_LOCK_TEMP_PREFIX}${claim.id}.${randomUUID()}${FILE_LOCK_TEMP_SUFFIX}`);
    try {
        await writeFile(temporaryPath, JSON.stringify(claim), {
            flag: FILE_LOCK_EXCLUSIVE_FLAG,
            mode: FILE_LOCK_FILE_MODE,
        });
        if (create)
            await link(temporaryPath, filePath);
        else {
            const replacementDeadline = deadline ?? performance.now() + FILE_LOCK_RENAME_RETRY_TIMEOUT_MS;
            for (;;) {
                try {
                    await rename(temporaryPath, filePath);
                    break;
                }
                catch (error) {
                    if (errorCode(error) !== PERMISSION_DENIED_CODE)
                        throw error;
                    await waitForNextScan(replacementDeadline, dirname(filePath));
                }
            }
        }
    }
    finally {
        await removeFile(temporaryPath);
    }
}
async function createClaim(claimDirectory) {
    for (;;) {
        const id = randomUUID();
        const claim = {
            version: FILE_LOCK_CLAIM_VERSION,
            id,
            pid: process.pid,
            choosing: true,
            ticket: FILE_LOCK_UNSELECTED_TICKET,
        };
        try {
            const path = join(claimDirectory, `${id}${FILE_LOCK_CLAIM_EXTENSION}`);
            await publishClaim(path, claim, true);
            startHeartbeat(path, id);
            return claim;
        }
        catch (error) {
            if (errorCode(error) !== FILE_EXISTS_CODE)
                throw error;
        }
    }
}
async function scanClaims(claimDirectory, ownPath) {
    const entries = await readdir(claimDirectory, { withFileTypes: true });
    const claims = [];
    const reference = ownPath === undefined ? undefined : await modifiedAt(ownPath);
    const abandoned = async (path) => {
        if (reference === undefined)
            return false;
        const modified = await modifiedAt(path);
        if (modified === undefined || reference - modified < FILE_LOCK_STALE_CLAIM_MS)
            return false;
        return removeFile(path);
    };
    for (const entry of entries) {
        if (!entry.name.endsWith(FILE_LOCK_CLAIM_EXTENSION))
            continue;
        const id = entry.name.slice(0, -FILE_LOCK_CLAIM_EXTENSION.length);
        const path = join(claimDirectory, entry.name);
        if (!entry.isFile())
            return { claims, blocked: true };
        let value;
        try {
            value = JSON.parse(await readFile(path, FILE_LOCK_ENCODING));
        }
        catch (error) {
            if (errorCode(error) === FILE_MISSING_CODE)
                continue;
            if (await abandoned(path))
                continue;
            return {
                claims,
                blocked: true,
                transient: isBusyFileError(error),
            };
        }
        const claim = parseClaim(value, id);
        if (!claim) {
            if (await abandoned(path))
                continue;
            return { claims, blocked: true };
        }
        const alive = processIsAlive(claim.pid);
        if (alive === false) {
            if (!(await removeFile(path)))
                return { claims, blocked: true };
            continue;
        }
        if (await abandoned(path))
            continue;
        if (alive === undefined)
            return { claims, blocked: true };
        claims.push(claim);
    }
    return { claims, blocked: false };
}
async function modifiedAt(path) {
    try {
        return (await lstat(path)).mtimeMs;
    }
    catch (error) {
        if (errorCode(error) === FILE_MISSING_CODE)
            return undefined;
        throw error;
    }
}
function claimPath(claimDirectory, id) {
    return join(claimDirectory, `${id}${FILE_LOCK_CLAIM_EXTENSION}`);
}
function hasClaimState(claims, id, choosing, ticket) {
    const claim = claims.find((peer) => peer.id === id);
    return claim?.choosing === choosing && claim.ticket === ticket;
}
function makeHandle(claimDirectory, claim) {
    let releasePromise;
    return {
        release() {
            stopHeartbeat(claim.id);
            releasePromise ??= removeFile(claimPath(claimDirectory, claim.id)).then((removed) => {
                if (!removed)
                    throw new Error(FILE_LOCK_RELEASE_MESSAGE);
            });
            return releasePromise;
        },
    };
}
async function beginClaim(filePath) {
    const claimDirectory = `${resolve(filePath)}${FILE_LOCK_DIRECTORY_SUFFIX}`;
    await assertSafeClaimDirectory(claimDirectory);
    await mkdir(claimDirectory, { recursive: true, mode: FILE_LOCK_DIRECTORY_MODE });
    await assertSafeClaimDirectory(claimDirectory);
    await chmod(claimDirectory, FILE_LOCK_DIRECTORY_MODE);
    return { claimDirectory, claim: await createClaim(claimDirectory) };
}
async function assertSafeClaimDirectory(claimDirectory) {
    let stat;
    try {
        stat = await lstat(claimDirectory);
    }
    catch (error) {
        if (errorCode(error) === FILE_MISSING_CODE)
            return;
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(FILE_LOCK_UNSAFE_DIRECTORY_MESSAGE);
}
function isStillBusy(attempt, scan) {
    return (!attempt.waitForPeers &&
        scan.blocked &&
        scan.transient === true &&
        performance.now() < attempt.busyDeadline);
}
async function waitOrReleaseClaim(attempt) {
    if (!attempt.waitForPeers) {
        await makeHandle(attempt.claimDirectory, attempt.claim).release();
        return false;
    }
    await waitForNextScan(attempt.deadline, attempt.claimDirectory);
    return true;
}
async function observePeers(attempt, expectedChoosing, expectedTicket) {
    for (;;) {
        const scan = await scanClaims(attempt.claimDirectory, attempt.ownPath);
        if (isStillBusy(attempt, scan)) {
            await delay(FILE_LOCK_POLL_INTERVAL_MS);
            continue;
        }
        if (scan.blocked ||
            !hasClaimState(scan.claims, attempt.claim.id, expectedChoosing, expectedTicket)) {
            if (!(await waitOrReleaseClaim(attempt)))
                return undefined;
            continue;
        }
        return scan.claims;
    }
}
async function takeTicket(attempt) {
    const { claim, claimDirectory, ownPath, waitForPeers } = attempt;
    const claims = await observePeers(attempt, true, FILE_LOCK_UNSELECTED_TICKET);
    if (claims === undefined)
        return undefined;
    if (!waitForPeers && claims.some((peer) => peer.id !== claim.id && !peer.choosing)) {
        await makeHandle(claimDirectory, claim).release();
        return undefined;
    }
    let maxTicket = FILE_LOCK_UNSELECTED_TICKET;
    for (const peer of claims)
        maxTicket = Math.max(maxTicket, peer.ticket);
    if (maxTicket >= Number.MAX_SAFE_INTEGER)
        throw new Error(FILE_LOCK_TICKET_LIMIT_MESSAGE);
    const ticketedClaim = { ...claim, choosing: false, ticket: maxTicket + 1 };
    await publishClaim(ownPath, ticketedClaim, false, waitForPeers ? attempt.deadline : attempt.busyDeadline);
    return ticketedClaim;
}
async function waitForTurn(attempt, ticketedClaim) {
    const { claim, claimDirectory, waitForPeers } = attempt;
    const choosingDeadline = performance.now() + FILE_LOCK_TRY_CHOOSING_WAIT_MS;
    for (;;) {
        const claims = await observePeers(attempt, false, ticketedClaim.ticket);
        if (claims === undefined)
            return undefined;
        const peers = claims.filter((peer) => peer.id !== claim.id);
        if (!waitForPeers &&
            !peers.some((peer) => !peer.choosing && precedes(peer, ticketedClaim)) &&
            peers.some((peer) => peer.choosing) &&
            performance.now() < choosingDeadline) {
            await delay(FILE_LOCK_POLL_INTERVAL_MS);
            continue;
        }
        if (peers.some((peer) => precedes(peer, ticketedClaim))) {
            if (!(await waitOrReleaseClaim(attempt)))
                return undefined;
            continue;
        }
        if (waitForPeers && performance.now() > attempt.deadline)
            throw new FileLockTimeoutError(claimDirectory);
        return { claimDirectory, claim: ticketedClaim };
    }
}
async function acquireClaim(filePath, waitForPeers, deadline) {
    const { claimDirectory, claim } = await beginClaim(filePath);
    const attempt = {
        filePath,
        claimDirectory,
        claim,
        ownPath: claimPath(claimDirectory, claim.id),
        waitForPeers,
        deadline,
        busyDeadline: performance.now() + FILE_LOCK_TRY_CHOOSING_WAIT_MS,
    };
    try {
        const ticketedClaim = await takeTicket(attempt);
        if (!ticketedClaim)
            return undefined;
        return await waitForTurn(attempt, ticketedClaim);
    }
    catch (error) {
        await makeHandle(claimDirectory, claim).release();
        throw error;
    }
}
export async function tryAcquireFileLock(filePath) {
    const acquired = await acquireClaim(filePath, false, 0);
    if (!acquired)
        return undefined;
    return makeHandle(acquired.claimDirectory, acquired.claim);
}
export async function acquireCompatibleDirectoryFileLock(filePath, options) {
    const resolvedPath = resolve(filePath);
    const deadline = performance.now() + timeoutMs(options);
    const gate = await acquireLegacyDirectoryGate(resolvedPath, deadline, tryAcquireFileLock);
    let acquired;
    try {
        acquired = await acquireClaim(resolvedPath, true, deadline);
        if (!acquired)
            throw new Error(FILE_LOCK_ACQUIRE_MESSAGE);
    }
    catch (error) {
        try {
            await releaseLegacyDirectoryGate(gate);
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], FILE_LOCK_COMPATIBLE_ACQUIRE_CLEANUP_MESSAGE, {
                cause: cleanupError,
            });
        }
        throw error;
    }
    const sharedHandle = makeHandle(acquired.claimDirectory, acquired.claim);
    let releasePromise;
    return {
        release() {
            releasePromise ??= (async () => {
                const errors = [];
                try {
                    await sharedHandle.release();
                }
                catch (error) {
                    errors.push(error);
                }
                try {
                    await releaseLegacyDirectoryGate(gate);
                }
                catch (error) {
                    errors.push(error);
                }
                if (errors.length === 1)
                    throw errors[0];
                if (errors.length > 1)
                    throw new AggregateError(errors, FILE_LOCK_COMPATIBLE_RELEASE_MESSAGE);
            })();
            return releasePromise;
        },
    };
}
export async function waitForFileLockClaim(filePath, pid, options) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new TypeError("Invalid file lock process ID");
    const waitMs = timeoutMs(options);
    const deadline = performance.now() + waitMs;
    const claimDirectory = `${resolve(filePath)}${FILE_LOCK_DIRECTORY_SUFFIX}`;
    for (;;) {
        await assertSafeClaimDirectory(claimDirectory);
        try {
            const scan = await scanClaims(claimDirectory);
            if (scan.claims.some((claim) => claim.pid === pid))
                return true;
        }
        catch (error) {
            if (errorCode(error) !== FILE_MISSING_CODE)
                throw error;
        }
        if (processIsAlive(pid) === false)
            return false;
        const remaining = deadline - performance.now();
        if (remaining <= 0)
            return false;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(FILE_LOCK_POLL_INTERVAL_MS, remaining)));
    }
}
function precedes(left, right) {
    return left.ticket < right.ticket || (left.ticket === right.ticket && left.id < right.id);
}
export async function withFileLock(filePath, callback, options) {
    const waitMs = timeoutMs(options);
    const deadline = performance.now() + waitMs;
    const acquired = await acquireClaim(filePath, true, deadline);
    if (!acquired)
        throw new Error(FILE_LOCK_ACQUIRE_MESSAGE);
    try {
        return await callback();
    }
    finally {
        await makeHandle(acquired.claimDirectory, acquired.claim).release();
    }
}
//# sourceMappingURL=file-lock.js.map