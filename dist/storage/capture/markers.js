import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorCode } from "../../utils/errors.js";
import { FILE_MISSING_CODE } from "../../utils/constants.js";
import { isPlainRecord, parseJsonObject } from "../../utils/validation/objects.js";
import { listPrivateDirectory } from "../../utils/files/private-directory.js";
import { removeEmptyAncestors, removeFileIfPresent } from "../../utils/files/cleanup.js";
import { CAPTURE_HASH, CAPTURE_FILE_EXTENSION, CAPTURE_JOBS_DIRECTORY, CAPTURE_MARKER_INVALID_MESSAGE, CAPTURE_MARKER_INVALID_WARNING, CAPTURE_MARKER_FILE, CAPTURE_MARKER_REMOVED_REASON, CAPTURE_MARKER_SUFFIX, CAPTURE_TURN_MARKER_FILE, CAPTURE_MARKER_VERSION, } from "./constants.js";
import { eventPath, captureRoot, captureDirectory, eventSegments, eventsDirectory, identifierHash, sessionsDirectory, turnsDirectory, } from "./paths.js";
import { publishExclusive, readPrivateFile, replacePrivateFile } from "./utils/atomic-file.js";
function markerPath(root, scope) {
    const path = eventPath(root, scope);
    return join(dirname(path), `${basename(eventPath(root, scope), CAPTURE_FILE_EXTENSION)}${CAPTURE_MARKER_SUFFIX}`);
}
function turnMarkerPath(root, scope) {
    return join(dirname(eventPath(root, scope)), CAPTURE_TURN_MARKER_FILE);
}
function needsMarker(record) {
    const outcomes = Object.values(record.delivery?.outcomes ?? {});
    return outcomes.length === 0 || outcomes.some(({ outcome }) => outcome === "dropped");
}
function markerOf(records) {
    return {
        version: CAPTURE_MARKER_VERSION,
        entries: Object.fromEntries(records.map((record) => [
            identifierHash(record.eventId),
            { runId: record.runId, outcomes: record.delivery?.outcomes ?? {} },
        ])),
        unsettled: {
            outcome: "dropped",
            reason: CAPTURE_MARKER_REMOVED_REASON,
            recordedAt: new Date().toISOString(),
        },
    };
}
export async function writeOutcomeMarker(root, scope, record) {
    if (!needsMarker(record))
        return;
    await publishExclusive(markerPath(root, scope), JSON.stringify(markerOf([record])));
}
export async function writeTurnMarker(root, records, settled) {
    const [first] = records;
    if (first === undefined)
        return;
    const path = turnMarkerPath(root, first);
    const previous = await readMarker(root, path);
    const fresh = markerOf(records);
    const marker = {
        ...fresh,
        entries: { ...previous?.entries, ...fresh.entries },
        ...((settled ?? previous?.settled) === undefined
            ? {}
            : { settled: (settled ?? previous?.settled) }),
    };
    if (previous === undefined)
        await publishExclusive(path, JSON.stringify(marker));
    else
        await replacePrivateFile(captureRoot(root), path, JSON.stringify(marker));
}
export async function readSettledTurn(root, scope) {
    const marker = await readMarker(root, join(captureRoot(root), ...eventSegments(root, scope), CAPTURE_TURN_MARKER_FILE));
    return marker?.settled;
}
function isOutcome(value) {
    return (isPlainRecord(value) &&
        (value["outcome"] === "delivered" || value["outcome"] === "dropped") &&
        typeof value["recordedAt"] === "string");
}
function isMarkerEntry(value) {
    return (isPlainRecord(value) &&
        typeof value["runId"] === "string" &&
        isPlainRecord(value["outcomes"]) &&
        Object.values(value["outcomes"]).every(isOutcome));
}
function isSettledTurn(value) {
    return (isPlainRecord(value) &&
        typeof value["rootRunId"] === "string" &&
        isPlainRecord(value["attribution"]) &&
        Object.values(value["attribution"]).every((entry) => typeof entry === "string"));
}
function isMarker(value) {
    return (value["version"] === CAPTURE_MARKER_VERSION &&
        isPlainRecord(value["entries"]) &&
        Object.values(value["entries"]).every(isMarkerEntry) &&
        isOutcome(value["unsettled"]) &&
        (value["settled"] === undefined || isSettledTurn(value["settled"])));
}
function parseMarker(contents) {
    try {
        const value = parseJsonObject(contents, CAPTURE_MARKER_INVALID_MESSAGE);
        return isMarker(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
async function readMarker(root, path) {
    const contents = await readPrivateFile(captureRoot(root), path);
    if (contents === undefined)
        return undefined;
    const marker = parseMarker(contents);
    if (marker !== undefined)
        return marker;
    console.warn(CAPTURE_MARKER_INVALID_WARNING, basename(path));
    await removeFileIfPresent(path);
    return undefined;
}
export async function readMarkerOutcome(root, scope, destination) {
    for (const path of [markerPath(root, scope), turnMarkerPath(root, scope)]) {
        const marker = await readMarker(root, path);
        const entry = marker?.entries[identifierHash(scope.eventId)];
        if (marker !== undefined && entry !== undefined)
            return entry.outcomes[destination] ?? marker.unsettled;
    }
    return undefined;
}
export async function readDroppedRunIds(root, scope) {
    const runIds = new Set();
    const directory = join(captureRoot(root), ...eventSegments(root, scope));
    for (const path of await markersIn(root, directory)) {
        const marker = await readMarker(root, path);
        for (const { runId, outcomes } of Object.values(marker?.entries ?? {})) {
            if (Object.values(outcomes).every(({ outcome }) => outcome === "dropped"))
                runIds.add(runId);
        }
    }
    return runIds;
}
export async function forgetTurnMarkers(root, scope) {
    const paths = captureDirectory(root) === CAPTURE_JOBS_DIRECTORY
        ? [markerPath(root, scope)]
        : await markersIn(root, dirname(eventPath(root, scope)));
    for (const path of paths)
        await removeFileIfPresent(path);
}
async function markersIn(root, directory) {
    return ((await listPrivateDirectory(captureRoot(root), directory)) ?? [])
        .filter((entry) => entry.isFile() && CAPTURE_MARKER_FILE.test(entry.name))
        .map((entry) => join(directory, entry.name));
}
export async function removeStaleMarkers(root, integration, modifiedBeforeMs) {
    const sessions = sessionsDirectory(root, integration);
    let removed = 0;
    for (const session of (await listPrivateDirectory(captureRoot(root), sessions)) ?? []) {
        if (!session.isDirectory() || !CAPTURE_HASH.test(session.name))
            continue;
        const turns = turnsDirectory(root, integration, session.name);
        const directories = captureDirectory(root) === CAPTURE_JOBS_DIRECTORY
            ? [turns]
            : ((await listPrivateDirectory(captureRoot(root), turns)) ?? [])
                .filter((turn) => turn.isDirectory() && CAPTURE_HASH.test(turn.name))
                .map((turn) => eventsDirectory(turns, turn.name));
        for (const directory of directories) {
            removed += await removeOldMarkers(root, directory, modifiedBeforeMs);
            await removeEmptyAncestors(directory, captureRoot(root));
        }
    }
    return removed;
}
async function removeOldMarkers(root, directory, modifiedBeforeMs) {
    let removed = 0;
    for (const path of await markersIn(root, directory)) {
        const info = await lstat(path).catch((error) => {
            if (errorCode(error) === FILE_MISSING_CODE)
                return undefined;
            throw error;
        });
        if (info === undefined || info.mtimeMs >= modifiedBeforeMs)
            continue;
        if (await removeFileIfPresent(path))
            removed += 1;
    }
    return removed;
}
//# sourceMappingURL=markers.js.map