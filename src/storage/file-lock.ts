import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rmdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  FILE_LOCK_ACQUIRE_MESSAGE,
  FILE_LOCK_COMPATIBLE_ACQUIRE_CLEANUP_MESSAGE,
  FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE,
  FILE_LOCK_COMPATIBLE_RELEASE_MESSAGE,
  FILE_LOCK_CLAIM_VERSION,
  FILE_LOCK_CLAIM_EXTENSION,
  FILE_LOCK_DIRECTORY_MODE,
  FILE_LOCK_DIRECTORY_SUFFIX,
  FILE_LOCK_DEFAULT_TIMEOUT_MS,
  FILE_LOCK_ENCODING,
  FILE_LOCK_EXISTS_CODE,
  FILE_LOCK_EXCLUSIVE_FLAG,
  FILE_LOCK_FILE_MODE,
  FILE_LOCK_INVALID_TIMEOUT_MESSAGE,
  FILE_LOCK_MISSING_CODE,
  FILE_LOCK_NEGATIVE_TICKET_LIMIT,
  FILE_LOCK_POLL_INTERVAL_MS,
  FILE_LOCK_PROCESS_MISSING_CODE,
  FILE_LOCK_PROCESS_CHECK_SIGNAL,
  FILE_LOCK_RELEASE_MESSAGE,
  FILE_LOCK_RENAME_RETRY_TIMEOUT_MS,
  FILE_LOCK_RENAME_BUSY_CODE,
  FILE_LOCK_TEMP_PREFIX,
  FILE_LOCK_TEMP_SUFFIX,
  FILE_LOCK_TICKET_LIMIT_MESSAGE,
  FILE_LOCK_UNSAFE_DIRECTORY_MESSAGE,
  FILE_LOCK_UNSELECTED_TICKET,
  FILE_LOCK_LEGACY_DIRECTORY_SUFFIX,
  FILE_LOCK_WINDOWS_DIRECTORY_CONTENTION_CODES,
} from "./constants.js";
import type {
  FileLockCallback,
  FileLockClaim,
  FileLockHandle,
  FileLockOptions,
  FileLockScanResult,
  BegunFileLock,
  LegacyDirectoryFileLockGate,
} from "./models.js";
import { FileLockTimeoutError } from "./errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseClaim(value: unknown, id: string): FileLockClaim | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== FILE_LOCK_CLAIM_VERSION ||
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
      : value.ticket === FILE_LOCK_UNSELECTED_TICKET)
  ) {
    return undefined;
  }
  return value as unknown as FileLockClaim;
}

async function processIsAlive(pid: number): Promise<boolean | undefined> {
  try {
    process.kill(pid, FILE_LOCK_PROCESS_CHECK_SIGNAL);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === FILE_LOCK_PROCESS_MISSING_CODE) return false;
    return undefined;
  }
}

async function removeFile(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_LOCK_MISSING_CODE) return true;
    return false;
  }
}

async function publishClaim(
  filePath: string,
  claim: FileLockClaim,
  create: boolean,
  deadline?: number,
): Promise<void> {
  const temporaryPath = join(
    dirname(filePath),
    `${FILE_LOCK_TEMP_PREFIX}${claim.id}.${randomUUID()}${FILE_LOCK_TEMP_SUFFIX}`,
  );
  try {
    await writeFile(temporaryPath, JSON.stringify(claim), {
      flag: FILE_LOCK_EXCLUSIVE_FLAG,
      mode: FILE_LOCK_FILE_MODE,
    });
    if (create) await link(temporaryPath, filePath);
    else {
      const replacementDeadline = deadline ?? performance.now() + FILE_LOCK_RENAME_RETRY_TIMEOUT_MS;
      for (;;) {
        try {
          await rename(temporaryPath, filePath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== FILE_LOCK_RENAME_BUSY_CODE) throw error;
          await waitForNextScan(replacementDeadline, filePath);
        }
      }
    }
  } finally {
    await removeFile(temporaryPath);
  }
}

async function createClaim(claimDirectory: string): Promise<FileLockClaim> {
  for (;;) {
    const id = randomUUID();
    const claim: FileLockClaim = {
      version: FILE_LOCK_CLAIM_VERSION,
      id,
      pid: process.pid,
      choosing: true,
      ticket: FILE_LOCK_UNSELECTED_TICKET,
    };
    try {
      await publishClaim(join(claimDirectory, `${id}${FILE_LOCK_CLAIM_EXTENSION}`), claim, true);
      return claim;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== FILE_LOCK_EXISTS_CODE) throw error;
    }
  }
}

async function scanClaims(claimDirectory: string): Promise<FileLockScanResult> {
  const entries = await readdir(claimDirectory, { withFileTypes: true });
  const claims: FileLockClaim[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(FILE_LOCK_CLAIM_EXTENSION)) continue;
    const id = entry.name.slice(0, -FILE_LOCK_CLAIM_EXTENSION.length);
    if (!entry.isFile()) return { claims, blocked: true };
    let value: unknown;
    try {
      value = JSON.parse(
        await readFile(join(claimDirectory, entry.name), FILE_LOCK_ENCODING),
      ) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === FILE_LOCK_MISSING_CODE) continue;
      return { claims, blocked: true };
    }
    const claim = parseClaim(value, id);
    if (!claim) return { claims, blocked: true };
    const alive = await processIsAlive(claim.pid);
    if (alive === false) {
      if (!(await removeFile(join(claimDirectory, entry.name)))) return { claims, blocked: true };
      continue;
    }
    if (alive === undefined) return { claims, blocked: true };
    claims.push(claim);
  }
  return { claims, blocked: false };
}

function claimPath(claimDirectory: string, id: string): string {
  return join(claimDirectory, `${id}${FILE_LOCK_CLAIM_EXTENSION}`);
}

function hasClaimState(
  claims: FileLockClaim[],
  id: string,
  choosing: boolean,
  ticket: number,
): boolean {
  const claim = claims.find((peer) => peer.id === id);
  return claim?.choosing === choosing && claim.ticket === ticket;
}

function makeHandle(claimDirectory: string, claim: FileLockClaim): FileLockHandle {
  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      releasePromise ??= removeFile(claimPath(claimDirectory, claim.id)).then((removed) => {
        if (!removed) throw new Error(FILE_LOCK_RELEASE_MESSAGE);
      });
      return releasePromise;
    },
  };
}

async function beginClaim(filePath: string): Promise<BegunFileLock> {
  const claimDirectory = `${resolve(filePath)}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  await assertSafeClaimDirectory(claimDirectory);
  await mkdir(claimDirectory, { recursive: true, mode: FILE_LOCK_DIRECTORY_MODE });
  await assertSafeClaimDirectory(claimDirectory);
  await chmod(claimDirectory, FILE_LOCK_DIRECTORY_MODE);
  return { claimDirectory, claim: await createClaim(claimDirectory) };
}

async function assertSafeClaimDirectory(claimDirectory: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(claimDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_LOCK_MISSING_CODE) return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(FILE_LOCK_UNSAFE_DIRECTORY_MESSAGE);
}

async function acquireClaim(
  filePath: string,
  waitForPeers: boolean,
  deadline: number,
): Promise<BegunFileLock | undefined> {
  const { claimDirectory, claim } = await beginClaim(filePath);
  const ownPath = claimPath(claimDirectory, claim.id);
  let ownedClaim: FileLockClaim | undefined;
  try {
    for (;;) {
      const scan = await scanClaims(claimDirectory);
      if (
        scan.blocked ||
        !hasClaimState(scan.claims, claim.id, true, FILE_LOCK_UNSELECTED_TICKET)
      ) {
        if (!(await waitOrReleaseClaim(waitForPeers, deadline, filePath, claimDirectory, claim)))
          return undefined;
        continue;
      }
      const peers = scan.claims.filter((peer) => peer.id !== claim.id);
      if (!waitForPeers && peers.length > 0) {
        await makeHandle(claimDirectory, claim).release();
        return undefined;
      }
      let maxTicket = FILE_LOCK_UNSELECTED_TICKET;
      for (const peer of scan.claims) maxTicket = Math.max(maxTicket, peer.ticket);
      if (maxTicket >= Number.MAX_SAFE_INTEGER) throw new Error(FILE_LOCK_TICKET_LIMIT_MESSAGE);
      ownedClaim = { ...claim, choosing: false, ticket: maxTicket + 1 };
      await publishClaim(ownPath, ownedClaim, false, waitForPeers ? deadline : undefined);
      break;
    }

    const ticketedClaim = ownedClaim;
    if (!ticketedClaim) throw new Error(FILE_LOCK_ACQUIRE_MESSAGE);
    for (;;) {
      const scan = await scanClaims(claimDirectory);
      if (scan.blocked || !hasClaimState(scan.claims, claim.id, false, ticketedClaim.ticket)) {
        if (!(await waitOrReleaseClaim(waitForPeers, deadline, filePath, claimDirectory, claim)))
          return undefined;
        continue;
      }
      const peers = scan.claims.filter((peer) => peer.id !== claim.id);
      const blockedByPeer =
        peers.length > 0 && (!waitForPeers || peers.some((peer) => precedes(peer, ticketedClaim)));
      if (blockedByPeer) {
        if (!(await waitOrReleaseClaim(waitForPeers, deadline, filePath, claimDirectory, claim)))
          return undefined;
        continue;
      }
      if (waitForPeers && performance.now() > deadline) throw timeoutError(filePath);
      return { claimDirectory, claim: ticketedClaim };
    }
  } catch (error) {
    await makeHandle(claimDirectory, claim).release();
    throw error;
  }
}

export async function tryAcquireFileLock(filePath: string): Promise<FileLockHandle | undefined> {
  const acquired = await acquireClaim(filePath, false, 0);
  if (!acquired) return undefined;
  return makeHandle(acquired.claimDirectory, acquired.claim);
}

async function acquireLegacyDirectoryGate(
  filePath: string,
  deadline: number,
): Promise<LegacyDirectoryFileLockGate> {
  const gatePath = `${filePath}${FILE_LOCK_LEGACY_DIRECTORY_SUFFIX}`;
  await mkdir(dirname(filePath), { recursive: true, mode: FILE_LOCK_DIRECTORY_MODE });
  let retriedMissingPermission = false;
  for (;;) {
    if (performance.now() >= deadline) throw timeoutError(filePath);
    try {
      await mkdir(gatePath, { mode: FILE_LOCK_DIRECTORY_MODE });
      const stat = await lstat(gatePath);
      if (!stat.isDirectory()) throw new Error(FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE);
      return { path: gatePath, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const permissionDenied = FILE_LOCK_WINDOWS_DIRECTORY_CONTENTION_CODES.some(
        (candidate) => candidate === code,
      );
      if (code !== FILE_LOCK_EXISTS_CODE && !permissionDenied) {
        throw error;
      }
      let isDirectory = false;
      try {
        isDirectory = (await lstat(gatePath)).isDirectory();
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === FILE_LOCK_MISSING_CODE) {
          if (code === FILE_LOCK_EXISTS_CODE) {
            retriedMissingPermission = false;
            await waitForNextScan(deadline, filePath);
            continue;
          }
          if (permissionDenied && !retriedMissingPermission) {
            retriedMissingPermission = true;
            continue;
          }
        }
        throw error;
      }
      if (!isDirectory) throw error;
      retriedMissingPermission = false;
      await waitForNextScan(deadline, filePath);
    }
  }
}

async function releaseLegacyDirectoryGate(gate: LegacyDirectoryFileLockGate): Promise<void> {
  let stat;
  try {
    stat = await lstat(gate.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_LOCK_MISSING_CODE) return;
    throw error;
  }
  if (
    !stat.isDirectory() ||
    stat.dev !== gate.dev ||
    stat.ino !== gate.ino ||
    stat.birthtimeMs !== gate.birthtimeMs
  ) {
    throw new Error(FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE);
  }
  await rmdir(gate.path);
}

export async function acquireCompatibleDirectoryFileLock(
  filePath: string,
  options?: FileLockOptions,
): Promise<FileLockHandle> {
  const resolvedPath = resolve(filePath);
  const deadline = performance.now() + timeoutMs(options);
  const gate = await acquireLegacyDirectoryGate(resolvedPath, deadline);
  let acquired: BegunFileLock | undefined;
  try {
    acquired = await acquireClaim(resolvedPath, true, deadline);
    if (!acquired) throw new Error(FILE_LOCK_ACQUIRE_MESSAGE);
  } catch (error) {
    try {
      await releaseLegacyDirectoryGate(gate);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        FILE_LOCK_COMPATIBLE_ACQUIRE_CLEANUP_MESSAGE,
        {
          cause: cleanupError,
        },
      );
    }
    throw error;
  }

  const sharedHandle = makeHandle(acquired.claimDirectory, acquired.claim);
  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      releasePromise ??= (async () => {
        const errors: unknown[] = [];
        try {
          await sharedHandle.release();
        } catch (error) {
          errors.push(error);
        }
        try {
          await releaseLegacyDirectoryGate(gate);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, FILE_LOCK_COMPATIBLE_RELEASE_MESSAGE);
      })();
      return releasePromise;
    },
  };
}

export async function waitForFileLockClaim(
  filePath: string,
  pid: number,
  options?: FileLockOptions,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("Invalid file lock process ID");
  const waitMs = timeoutMs(options);
  const deadline = performance.now() + waitMs;
  const claimDirectory = `${resolve(filePath)}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  for (;;) {
    await assertSafeClaimDirectory(claimDirectory);
    try {
      const scan = await scanClaims(claimDirectory);
      if (scan.claims.some((claim) => claim.pid === pid)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== FILE_LOCK_MISSING_CODE) throw error;
    }
    if ((await processIsAlive(pid)) === false) return false;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, Math.min(FILE_LOCK_POLL_INTERVAL_MS, remaining)),
    );
  }
}

function precedes(left: FileLockClaim, right: FileLockClaim): boolean {
  return left.ticket < right.ticket || (left.ticket === right.ticket && left.id < right.id);
}

function timeoutError(filePath: string): Error {
  return new FileLockTimeoutError(filePath);
}

function timeoutMs(options: FileLockOptions | undefined): number {
  const value = options?.timeoutMs ?? FILE_LOCK_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(FILE_LOCK_INVALID_TIMEOUT_MESSAGE);
  return value;
}

function waitForNextScan(deadline: number, filePath: string): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(timeoutError(filePath));
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, Math.min(FILE_LOCK_POLL_INTERVAL_MS, remaining)),
  );
}

async function waitOrReleaseClaim(
  waitForPeers: boolean,
  deadline: number,
  filePath: string,
  claimDirectory: string,
  claim: FileLockClaim,
): Promise<boolean> {
  if (!waitForPeers) {
    await makeHandle(claimDirectory, claim).release();
    return false;
  }
  await waitForNextScan(deadline, filePath);
  return true;
}

export async function withFileLock<T>(
  filePath: string,
  callback: FileLockCallback<T>,
  options?: FileLockOptions,
): Promise<T> {
  const waitMs = timeoutMs(options);
  const deadline = performance.now() + waitMs;
  const acquired = await acquireClaim(filePath, true, deadline);
  if (!acquired) throw new Error(FILE_LOCK_ACQUIRE_MESSAGE);
  try {
    return await callback();
  } finally {
    await makeHandle(acquired.claimDirectory, acquired.claim).release();
  }
}
