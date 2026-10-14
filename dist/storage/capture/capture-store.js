import { CaptureRecordInvalidError, CaptureRecordVersionError } from "./errors.js";
import { describe, errorCode } from "../../utils/errors.js";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { withFileLock } from "../index.js";
import { removeEmptyLockFolders } from "../lock-folders.js";
import { CAPTURE_DEPENDENCIES_INVALID_MESSAGE, CAPTURE_DEPENDENCY_INTEGRATION_MESSAGE, CAPTURE_DEPENDENCY_INVALID_MESSAGE, CAPTURE_DEPENDENCY_SELF_MESSAGE, CAPTURE_DEPENDENCY_UNIQUE_MESSAGE, CAPTURE_EVENT_FILE, CAPTURE_FIELD_UNSUPPORTED_MESSAGE, CAPTURE_HASH, CAPTURE_TURNS_DIRECTORY, CAPTURE_NAMESPACE_MISMATCH_MESSAGE, CAPTURE_OUTCOME_INVALID_MESSAGE, CAPTURE_OUTCOME_UNSUPPORTED_MESSAGE, CAPTURE_RECORD_UNSUPPORTED_MESSAGE, CAPTURE_RECORD_VERSION, CAPTURE_RETRY_LOST_MESSAGE, CAPTURE_ROUTES_INVALID_MESSAGE, CAPTURE_ROUTE_INVALID_MESSAGE, CAPTURE_ROUTE_PROJECT_INVALID_MESSAGE, CAPTURE_SKIPPED_WARNING, CAPTURE_UNREADABLE_WARNING, CAPTURE_VERSION_UNSUPPORTED_MESSAGE, } from "./constants.js";
import { eventPath, recordLockPath, captureRoot, captureDirectory, eventSegments, eventsDirectory, identifierHash, sessionsDirectory, turnsDirectory, validateIdentifier, validateIntegration, } from "./paths.js";
import { ensurePrivateDirectory, publishExclusive, readPrivateFile, replacePrivateFile, retryRemovedDirectory, } from "./utils/atomic-file.js";
import { listPrivateDirectory } from "../../utils/files/private-directory.js";
import { removeEmptyAncestors, removeFileIfPresent } from "../../utils/files/cleanup.js";
import { parseJsonObject, requireNonNegativeInteger, requireSafeEpochMilliseconds, } from "../../utils/validation/objects.js";
import { scopeOf } from "./scope.js";
import { compareCaptureOrder } from "./order.js";
import { captureContentDigest } from "./utils/digest.js";
import { forgetTurnMarkers, readDroppedRunIds, readSettledTurn, readMarkerOutcome, removeStaleMarkers, writeOutcomeMarker, writeTurnMarker, } from "./markers.js";
import { canonicalJson, canonicalValue } from "./utils/serialization.js";
export function createCaptureStore(root, directory = CAPTURE_TURNS_DIRECTORY) {
    const storageRoot = { root: resolve(root), directory };
    captureDirectory(storageRoot);
    return {
        capture: (input) => captureEvent(storageRoot, input),
        read: (scope) => readCapture(storageRoot, scope),
        async enumerate(integration, sessionId) {
            validateIntegration(integration);
            validateIdentifier(sessionId, "session ID");
            return enumerateTurns(storageRoot, integration, identifierHash(sessionId), () => true);
        },
        async enumerateTurn(integration, sessionId, turnId) {
            validateIntegration(integration);
            validateIdentifier(sessionId, "session ID");
            validateIdentifier(turnId, "turn ID");
            const turnHash = identifierHash(turnId);
            return enumerateTurns(storageRoot, integration, identifierHash(sessionId), (name) => name === turnHash);
        },
        enumerateSessions: (integration) => enumerateIntegrationSessions(storageRoot, integration),
        recordRetry: (scope, destination, retry) => recordRetryState(storageRoot, scope, destination, retry),
        recordOutcome: (input) => recordDeliveryOutcome(storageRoot, input),
        readOutcome: (scope, destination) => readDeliveryOutcome(storageRoot, scope, destination),
        remove: (scope, options) => removeCapture(storageRoot, scope, options),
        removeTurn: (records, settled) => removeTurnWithMarker(storageRoot, records, settled),
        readSettledTurn: (integration, sessionId, turnId) => readSettledTurn(storageRoot, { integration, sessionId, turnId }),
        readDroppedRunIds: (integration, sessionId, turnId) => readDroppedRunIds(storageRoot, { integration, sessionId, turnId }),
        removeStaleMarkers: (integration, modifiedBeforeMs) => removeStaleMarkers(storageRoot, integration, modifiedBeforeMs),
    };
}
function buildCaptureRecord(input) {
    validateScope(input);
    const dependencies = normalizeDependencies(input.dependencies, input);
    validateIdentifier(input.runId, "run ID");
    validateIdentifier(input.destinationFingerprint, "destination fingerprint");
    validateIdentifier(input.eventKind, "event kind");
    return {
        version: CAPTURE_RECORD_VERSION,
        capturedAtMs: Date.now(),
        integration: input.integration,
        sessionId: input.sessionId,
        turnId: input.turnId,
        eventId: input.eventId,
        runId: input.runId,
        destinationFingerprint: input.destinationFingerprint,
        eventKind: input.eventKind,
        normalizedPayload: canonicalValue(input.normalizedPayload, new Set()),
        turnEvidence: canonicalValue(input.turnEvidence, new Set()),
        metadataProvenance: canonicalValue(input.metadataProvenance, new Set()),
        ...(input.sourceAgeStartedAtMs === undefined
            ? {}
            : {
                sourceAgeStartedAtMs: requireSafeEpochMilliseconds(input.sourceAgeStartedAtMs, "Source age"),
            }),
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(input.destinationRoutes === undefined
            ? {}
            : { destinationRoutes: normalizeDestinationRoutes(input.destinationRoutes) }),
    };
}
async function publishCapture(root, input, record, contents) {
    const path = eventPath(root, input);
    return withRecordLock(root, input, async () => {
        const published = await retryRemovedDirectory(async () => {
            await ensureEventDirectory(root, input.integration, input.sessionId, input.turnId);
            return publishExclusive(path, contents);
        });
        if (published)
            return { status: "published", record };
        const previous = await readRecord(root, path);
        if (previous === undefined)
            return {
                status: "failed",
                code: "STORAGE_FAILED",
                message: "Published event disappeared",
            };
        if (!sameScope(previous, input))
            return { status: "conflict" };
        return sameCapture(previous, record)
            ? { status: "duplicate", record: previous }
            : { status: "conflict" };
    });
}
async function captureEvent(root, input) {
    let record;
    let contents;
    try {
        record = buildCaptureRecord(input);
        contents = canonicalJson(record);
    }
    catch (error) {
        return failure("SERIALIZATION_FAILED", error);
    }
    try {
        return await publishCapture(root, input, record, contents);
    }
    catch (error) {
        return failure("STORAGE_FAILED", error);
    }
}
async function readCapture(root, scope) {
    validateScope(scope);
    const record = await readRecord(root, eventPath(root, scope));
    if (record === undefined)
        return undefined;
    if (!sameScope(record, scope))
        throw new Error(CAPTURE_NAMESPACE_MISMATCH_MESSAGE);
    return record;
}
async function enumerateIntegrationSessions(root, integration) {
    validateIntegration(integration);
    const sessions = [];
    for (const directory of (await listPrivateDirectory(captureRoot(root), sessionsDirectory(root, integration))) ?? []) {
        if (!directory.isDirectory() || !CAPTURE_HASH.test(directory.name))
            continue;
        const captures = await enumerateTurns(root, integration, directory.name, () => true);
        if (captures.length > 0)
            sessions.push({ sessionId: captures[0].record.sessionId, captures });
    }
    return sessions.toSorted((left, right) => left.sessionId === right.sessionId ? 0 : left.sessionId < right.sessionId ? -1 : 1);
}
async function recordRetryState(root, scope, destination, retry) {
    validateScope(scope);
    validateIdentifier(destination, "destination");
    requireNonNegativeInteger(retry.failures, "Delivery failures");
    requireSafeEpochMilliseconds(retry.notBeforeMs, "Retry time");
    if (retry.recordedAtMs !== undefined)
        requireSafeEpochMilliseconds(retry.recordedAtMs, "Retry record time");
    await withRecordLock(root, scope, async (lock) => {
        const path = eventPath(root, scope);
        const record = await readRecord(root, path);
        if (record === undefined)
            throw new Error(CAPTURE_RETRY_LOST_MESSAGE);
        const delivery = deliveryOf(record);
        await saveDelivery(root, path, record, { ...delivery, retries: { ...delivery.retries, [destination]: retry } }, lock);
    });
}
function validateOutcomeInput(input) {
    validateScope(input);
    validateIdentifier(input.destination, "destination");
    if (input.outcome !== "delivered" && input.outcome !== "dropped")
        throw new TypeError(CAPTURE_OUTCOME_INVALID_MESSAGE);
    if (input.reason !== undefined)
        validateIdentifier(input.reason, "outcome reason");
}
async function recordDeliveryOutcome(root, input) {
    try {
        validateOutcomeInput(input);
        return await withRecordLock(root, input, async (lock) => {
            const path = eventPath(root, input);
            const record = await readRecord(root, path);
            if (record === undefined)
                return { status: "missing-capture" };
            const delivery = deliveryOf(record);
            const previous = delivery.outcomes[input.destination];
            if (previous !== undefined)
                return sameOutcome(previous, input)
                    ? { status: "duplicate", receipt: receiptOf(input, previous) }
                    : { status: "conflict" };
            const outcome = {
                outcome: input.outcome,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
                recordedAt: new Date().toISOString(),
            };
            await saveDelivery(root, path, record, { ...delivery, outcomes: { ...delivery.outcomes, [input.destination]: outcome } }, lock);
            return { status: "recorded", receipt: receiptOf(input, outcome) };
        });
    }
    catch (error) {
        return failure("STORAGE_FAILED", error);
    }
}
async function readDeliveryOutcome(root, scope, destination) {
    try {
        validateScope(scope);
        validateIdentifier(destination, "destination");
        const record = await readRecord(root, eventPath(root, scope));
        if (record === undefined) {
            const removed = await readMarkerOutcome(root, scope, destination);
            return removed === undefined
                ? { status: "missing-capture" }
                : { status: "settled", receipt: receiptOf({ ...scope, destination }, removed) };
        }
        if (!sameScope(record, scope))
            throw new Error(CAPTURE_NAMESPACE_MISMATCH_MESSAGE);
        const outcome = record.delivery?.outcomes[destination];
        return outcome === undefined
            ? { status: "pending" }
            : { status: "settled", receipt: receiptOf({ ...scope, destination }, outcome) };
    }
    catch (error) {
        return failure("STORAGE_FAILED", error);
    }
}
async function removeTurnWithMarker(root, records, settled) {
    await writeTurnMarker(root, records, settled);
    for (const record of records)
        await removeCapture(root, scopeOf(record), {}, false);
}
async function removeCapture(root, scope, options = {}, leaveMarker = true) {
    validateScope(scope);
    await withRecordLock(root, scope, async () => {
        const path = eventPath(root, scope);
        const record = options.forgetTurn || !leaveMarker ? undefined : await readRecord(root, path);
        if (record !== undefined && captureDirectory(root) === CAPTURE_TURNS_DIRECTORY)
            await writeOutcomeMarker(root, scope, record);
        await removeFileIfPresent(path);
    });
    if (options.forgetTurn)
        await forgetTurnMarkers(root, scope);
    await removeEmptyLockFolders(recordLockPath(root, scope), captureRoot(root));
    await removeEmptyAncestors(dirname(eventPath(root, scope)), captureRoot(root));
}
async function saveDelivery(root, path, record, delivery, lock) {
    await replacePrivateFile(captureRoot(root), path, canonicalJson({ ...record, delivery }), () => lock.assertHeld());
}
async function ensureEventDirectory(root, integration, sessionId, turnId) {
    await ensurePrivateDirectory(captureRoot(root), eventSegments(root, { integration, sessionId, turnId }));
}
async function withRecordLock(root, scope, operation) {
    validateScope(scope);
    await ensurePrivateDirectory(captureRoot(root), eventSegments(root, scope));
    return withFileLock(recordLockPath(root, scope), operation);
}
function compareCaptures(left, right) {
    return compareCaptureOrder({ capturedAtMs: left.capturedAtMs, eventId: left.record.eventId }, { capturedAtMs: right.capturedAtMs, eventId: right.record.eventId });
}
async function enumerateTurns(root, integration, sessionHash, wanted) {
    const turns = turnsDirectory(root, integration, sessionHash);
    const captures = [];
    if (captureDirectory(root) !== CAPTURE_TURNS_DIRECTORY)
        return enumerateEvents(root, turns, integration, sessionHash, wanted);
    for (const turn of (await listPrivateDirectory(captureRoot(root), turns)) ?? []) {
        if (!turn.isDirectory() || !CAPTURE_HASH.test(turn.name) || !wanted(turn.name))
            continue;
        const eventDirectory = eventsDirectory(turns, turn.name);
        captures.push(...(await enumerateEvents(root, eventDirectory, integration, sessionHash, (turnHash) => turnHash === turn.name)));
    }
    return captures.toSorted(compareCaptures);
}
async function enumerateEvents(root, directory, integration, sessionHash, wanted) {
    const captures = [];
    for (const event of (await listPrivateDirectory(captureRoot(root), directory)) ?? []) {
        if (!event.isFile() || !CAPTURE_EVENT_FILE.test(event.name))
            continue;
        const path = join(directory, event.name);
        const record = await readEvent(root, path);
        if (record === undefined ||
            identifierHash(record.sessionId) !== sessionHash ||
            eventPath(root, record) !== path) {
            if (record !== undefined)
                await discardEvent(path, "it does not match its folder");
            continue;
        }
        if (record.integration !== integration || !wanted(identifierHash(record.turnId)))
            continue;
        const info = await lstat(path);
        captures.push({ record, capturedAtMs: record.capturedAtMs, modifiedAtMs: info.mtimeMs });
    }
    return captures.toSorted(compareCaptures);
}
async function readEvent(root, path) {
    try {
        return await readRecord(root, path);
    }
    catch (error) {
        if (error instanceof CaptureRecordInvalidError)
            await discardEvent(path, describe(error));
        else
            console.warn(CAPTURE_SKIPPED_WARNING, `${basename(path)} (${describe(error)})`);
        return undefined;
    }
}
async function discardEvent(path, reason) {
    await removeFileIfPresent(path);
    console.warn(CAPTURE_UNREADABLE_WARNING, `${basename(path)} (${reason})`);
}
function sameCapture(left, right) {
    return captureContentDigest(left) === captureContentDigest(right);
}
function deliveryOf(record) {
    return record.delivery ?? { retries: {}, outcomes: {} };
}
function receiptOf(scope, outcome) {
    return {
        integration: scope.integration,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        eventId: scope.eventId,
        destination: scope.destination,
        ...outcome,
    };
}
function sameOutcome(outcome, input) {
    return outcome.outcome === input.outcome && outcome.reason === input.reason;
}
async function readRecord(root, path) {
    const contents = await readPrivateFile(captureRoot(root), path);
    if (contents === undefined)
        return undefined;
    let value;
    try {
        value = parseJsonObject(contents, "Invalid storage record");
    }
    catch (error) {
        throw new CaptureRecordInvalidError(describe(error));
    }
    if (typeof value.version === "number" && value.version !== CAPTURE_RECORD_VERSION)
        throw new CaptureRecordVersionError(`${CAPTURE_VERSION_UNSUPPORTED_MESSAGE} ${value.version}`);
    try {
        return validateRecord(value);
    }
    catch (error) {
        throw new CaptureRecordInvalidError(describe(error));
    }
}
function validateRecord(value) {
    if (value.version !== CAPTURE_RECORD_VERSION ||
        typeof value.capturedAtMs !== "number" ||
        !Number.isSafeInteger(value.capturedAtMs) ||
        !Number.isFinite(new Date(value.capturedAtMs).getTime()) ||
        typeof value.integration !== "string" ||
        typeof value.sessionId !== "string" ||
        typeof value.turnId !== "string" ||
        typeof value.eventId !== "string" ||
        typeof value.runId !== "string" ||
        typeof value.destinationFingerprint !== "string" ||
        typeof value.eventKind !== "string" ||
        !("normalizedPayload" in value) ||
        !("turnEvidence" in value) ||
        !("metadataProvenance" in value)) {
        throw new Error(CAPTURE_RECORD_UNSUPPORTED_MESSAGE);
    }
    if ("sourceAgeStartedAtMs" in value) {
        requireSafeEpochMilliseconds(value["sourceAgeStartedAtMs"], "Stored source age");
    }
    for (const [identifier, name] of [
        [value.runId, "run ID"],
        [value.destinationFingerprint, "destination fingerprint"],
        [value.eventKind, "event kind"],
    ]) {
        validateIdentifier(identifier, name);
    }
    const scope = {
        integration: value.integration,
        sessionId: value.sessionId,
        turnId: value.turnId,
        eventId: value.eventId,
    };
    validateScope(scope);
    const dependencies = normalizeDependencies(value.dependencies, scope);
    if ("destinationRoutes" in value)
        normalizeDestinationRoutes(value.destinationRoutes);
    const normalizedPayload = canonicalValue(value.normalizedPayload, new Set());
    const delivery = "delivery" in value ? readDelivery(value.delivery) : undefined;
    return {
        ...value,
        normalizedPayload,
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(delivery === undefined ? {} : { delivery }),
    };
}
function readDelivery(value) {
    const record = parseRecordObject(value, "delivery");
    const retries = parseRecordObject(record.retries, "delivery retries");
    const outcomes = parseRecordObject(record.outcomes, "delivery outcomes");
    for (const [destination, retry] of Object.entries(retries)) {
        validateIdentifier(destination, "destination");
        const entry = parseRecordObject(retry, "delivery retry");
        requireNonNegativeInteger(entry.failures, "Stored delivery failures");
        requireSafeEpochMilliseconds(entry.notBeforeMs, "Stored retry time");
        if (entry.recordedAtMs !== undefined)
            requireSafeEpochMilliseconds(entry.recordedAtMs, "Stored retry record time");
    }
    for (const [destination, outcome] of Object.entries(outcomes)) {
        validateIdentifier(destination, "destination");
        const entry = parseRecordObject(outcome, "delivery outcome");
        const recordedAt = new Date(String(entry.recordedAt));
        if ((entry.outcome !== "delivered" && entry.outcome !== "dropped") ||
            ("reason" in entry && typeof entry.reason !== "string") ||
            !Number.isFinite(recordedAt.getTime()) ||
            recordedAt.toISOString() !== entry.recordedAt)
            throw new Error(CAPTURE_OUTCOME_UNSUPPORTED_MESSAGE);
        if ("reason" in entry)
            validateIdentifier(entry.reason, "outcome reason");
    }
    return { retries, outcomes };
}
function parseRecordObject(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${CAPTURE_FIELD_UNSUPPORTED_MESSAGE} ${name}`);
    return value;
}
function validateScope(scope) {
    validateIntegration(scope.integration);
    validateIdentifier(scope.sessionId, "session ID");
    validateIdentifier(scope.turnId, "turn ID");
    validateIdentifier(scope.eventId, "event ID");
}
function normalizeDependencies(value, dependent) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new TypeError(CAPTURE_DEPENDENCIES_INVALID_MESSAGE);
    const seen = new Set();
    return value.map((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item))
            throw new TypeError(CAPTURE_DEPENDENCY_INVALID_MESSAGE);
        const candidate = item;
        if (typeof candidate.integration !== "string" ||
            typeof candidate.sessionId !== "string" ||
            typeof candidate.turnId !== "string" ||
            typeof candidate.eventId !== "string") {
            throw new TypeError(CAPTURE_DEPENDENCY_INVALID_MESSAGE);
        }
        const dependency = {
            integration: candidate.integration,
            sessionId: candidate.sessionId,
            turnId: candidate.turnId,
            eventId: candidate.eventId,
        };
        validateScope(dependency);
        if (dependency.integration !== dependent.integration)
            throw new TypeError(CAPTURE_DEPENDENCY_INTEGRATION_MESSAGE);
        if (sameScope(dependency, dependent))
            throw new TypeError(CAPTURE_DEPENDENCY_SELF_MESSAGE);
        const key = canonicalJson(dependency);
        if (seen.has(key))
            throw new TypeError(CAPTURE_DEPENDENCY_UNIQUE_MESSAGE);
        seen.add(key);
        return dependency;
    });
}
function normalizeDestinationRoutes(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new TypeError(CAPTURE_ROUTES_INVALID_MESSAGE);
    const routes = {};
    for (const [destination, route] of Object.entries(value)) {
        validateIdentifier(destination, "destination");
        if (route === null || typeof route !== "object" || Array.isArray(route))
            throw new TypeError(CAPTURE_ROUTE_INVALID_MESSAGE);
        const { projectName, sourceProjectName, ...extra } = route;
        if (Object.keys(extra).length > 0)
            throw new TypeError(CAPTURE_ROUTE_INVALID_MESSAGE);
        if (typeof projectName !== "string")
            throw new TypeError(CAPTURE_ROUTE_PROJECT_INVALID_MESSAGE);
        validateIdentifier(projectName, "route project");
        if (sourceProjectName !== undefined) {
            if (typeof sourceProjectName !== "string")
                throw new TypeError(CAPTURE_ROUTE_PROJECT_INVALID_MESSAGE);
            validateIdentifier(sourceProjectName, "route project");
        }
        routes[destination] = {
            projectName,
            ...(sourceProjectName === undefined ? {} : { sourceProjectName }),
        };
    }
    return routes;
}
function sameScope(record, scope) {
    return (record.integration === scope.integration &&
        record.sessionId === scope.sessionId &&
        record.turnId === scope.turnId &&
        record.eventId === scope.eventId);
}
function failure(code, error) {
    return {
        status: "failed",
        code: errorCode(error) ?? code,
        message: error instanceof Error ? error.message : String(error),
    };
}
//# sourceMappingURL=capture-store.js.map