import { existsSync } from "node:fs";
import { join } from "node:path";
import { listPrivateDirectory } from "../../utils/files/private-directory.js";
import { tryAcquireFileLock } from "../../storage/index.js";
import { FILE_LOCK_DIRECTORY_SUFFIX } from "../../storage/constants.js";
import { identifierHash } from "../../storage/capture/paths.js";
import { ensurePrivateDirectory } from "../../storage/capture/utils/atomic-file.js";
import { removeEmptyDirectories, removeEmptyTree } from "../../utils/files/cleanup.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import { CAPTURE_DIRECTORY, CAPTURE_RECORD_LOCK_DIRECTORY, } from "../../storage/capture/constants.js";
import { BACKGROUND_WORKER_DIRECTORY } from "../background-worker/constants.js";
import { DELIVERY_DIRECTORY } from "../delivery/constants.js";
import { RECONSTRUCTION_DIRECTORY, RECONSTRUCTION_WORKER_DIRECTORY, } from "../reconstruction/constants.js";
import { LIFECYCLE_PATCH_EVENT_KIND, LIFECYCLE_POST_EVENT_KIND, LIFECYCLE_RETIRE_AFTER_MS, LIFECYCLE_TOMBSTONE_RETENTION_MS, LIFECYCLE_SETTLEMENT_EVENT_KIND, LIFECYCLE_SETTLEMENT_LOCK_ACCOUNTS_DIRECTORY, LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY, LIFECYCLE_SETTLEMENT_LOCK_FILE, LIFECYCLE_SETTLEMENT_LOCK_INTEGRATIONS_DIRECTORY, LIFECYCLE_SETTLEMENT_LOCK_SESSIONS_DIRECTORY, LIFECYCLE_SNAPSHOT_LOCK_DIRECTORY, LIFECYCLE_SNAPSHOT_LOCK_FILE, } from "./constants.js";
export async function retireSettledSessions(options) {
    const retireBefore = options.now - LIFECYCLE_RETIRE_AFTER_MS;
    const retireSession = async (sessionId) => {
        const turns = new Map();
        for (const { record } of await options.store.enumerate(options.integration, sessionId)) {
            turns.set(record.turnId, [...(turns.get(record.turnId) ?? []), record]);
        }
        for (const [turnId, records] of turns) {
            const lastWriteMs = await options.lastSettledWrite(records);
            if (lastWriteMs === undefined || lastWriteMs > retireBefore)
                continue;
            await options.store.retireTurn(options.integration, sessionId, turnId, records, retireBefore);
            for (const record of records)
                await options.attempts.clear(record);
            await options.afterRetire?.(sessionId, turnId, records);
        }
    };
    await retireSession(options.sessionId);
    for (const { sessionId } of await options.store.enumerateSessions(options.integration)) {
        if (sessionId === options.sessionId)
            continue;
        const lock = await tryAcquireFileLock(await options.lockPath(sessionId));
        if (lock === undefined)
            continue;
        try {
            await retireSession(sessionId);
        }
        finally {
            await lock.release();
        }
    }
}
export async function retireDeliveredTurns(options) {
    const { storageRoot, integration } = options;
    await retireSettledSessions({
        ...options,
        lockPath: async (sessionId) => join(await ensurePrivateDirectory(storageRoot, [
            LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY,
            LIFECYCLE_SETTLEMENT_LOCK_INTEGRATIONS_DIRECTORY,
            integration,
            LIFECYCLE_SETTLEMENT_LOCK_SESSIONS_DIRECTORY,
            identifierHash(sessionId),
            LIFECYCLE_SETTLEMENT_LOCK_ACCOUNTS_DIRECTORY,
            identifierHash(options.destinationFingerprint),
        ]), LIFECYCLE_SETTLEMENT_LOCK_FILE),
        lastSettledWrite: (records) => settledTurnLastWrite(options, records),
        afterRetire: async (sessionId, turnId, records) => {
            const turn = join(storageRoot, LIFECYCLE_SNAPSHOT_LOCK_DIRECTORY, "integrations", integration, "sessions", identifierHash(sessionId), "turns", identifierHash(turnId));
            const runs = [
                ...new Set(records.map(({ runId }) => join(turn, "runs", identifierHash(runId)))),
            ];
            await removeEmptyDirectories([
                ...runs.flatMap((run) => [
                    join(run, `${LIFECYCLE_SNAPSHOT_LOCK_FILE}${FILE_LOCK_DIRECTORY_SUFFIX}`),
                    run,
                ]),
                join(turn, "runs"),
                turn,
                join(turn, ".."),
                join(turn, "..", ".."),
            ]);
        },
    });
    await pruneExpiredSessions(options);
}
async function pruneExpiredSessions(options) {
    const { storageRoot, integration } = options;
    const reconstructionRoot = join(storageRoot, RECONSTRUCTION_DIRECTORY);
    const retiredBefore = options.now - LIFECYCLE_TOMBSTONE_RETENTION_MS;
    await options.store.expireRetired(integration, retiredBefore);
    await createCaptureStore(reconstructionRoot).expireRetired(integration, retiredBefore);
    const captures = [
        join(storageRoot, CAPTURE_DIRECTORY, "integrations", integration, "sessions"),
        join(reconstructionRoot, CAPTURE_DIRECTORY, "integrations", integration, "sessions"),
    ];
    const areas = [
        ...captures,
        join(storageRoot, CAPTURE_RECORD_LOCK_DIRECTORY, "integrations", integration, "sessions"),
        join(storageRoot, DELIVERY_DIRECTORY, "integrations", integration, "sessions"),
        join(storageRoot, LIFECYCLE_SNAPSHOT_LOCK_DIRECTORY, "integrations", integration, "sessions"),
        join(storageRoot, LIFECYCLE_SETTLEMENT_LOCK_DIRECTORY, "integrations", integration, "sessions"),
        join(storageRoot, BACKGROUND_WORKER_DIRECTORY, "integrations", integration, "sessions"),
        join(reconstructionRoot, RECONSTRUCTION_WORKER_DIRECTORY, integration, "sessions"),
        join(reconstructionRoot, CAPTURE_RECORD_LOCK_DIRECTORY, "integrations", integration, "sessions"),
        join(reconstructionRoot, DELIVERY_DIRECTORY, "integrations", integration, "sessions"),
    ];
    const sessions = new Set();
    for (const area of areas)
        for (const entry of (await listPrivateDirectory(storageRoot, area)) ?? [])
            if (entry.isDirectory())
                sessions.add(entry.name);
    sessions.delete(identifierHash(options.sessionId));
    for (const session of sessions) {
        if (captures.some((area) => existsSync(join(area, session))))
            continue;
        for (const area of areas)
            await removeEmptyTree(join(area, session));
    }
}
async function settledTurnLastWrite(options, records) {
    let lastWriteMs = 0;
    for (const record of records) {
        if (record.destinationFingerprint !== options.destinationFingerprint)
            return undefined;
        const runPayload = record.eventKind === LIFECYCLE_POST_EVENT_KIND ||
            record.eventKind === LIFECYCLE_PATCH_EVENT_KIND;
        if (runPayload
            ? record.compaction === undefined
            : record.eventKind !== LIFECYCLE_SETTLEMENT_EVENT_KIND)
            return undefined;
        lastWriteMs = Math.max(lastWriteMs, record.capturedAtMs);
        for (const destination of options.destinations) {
            const outcome = await options.store.readOutcome(record, destination.id);
            if (outcome.status !== "settled")
                return undefined;
            lastWriteMs = Math.max(lastWriteMs, Date.parse(outcome.receipt.recordedAt));
        }
    }
    return lastWriteMs;
}
//# sourceMappingURL=cleanup.js.map