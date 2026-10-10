import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CAPTURE_DIRECTORY, CAPTURE_EVENT_FILE, CAPTURE_HASH, CAPTURE_RECORD_VERSION, CAPTURE_RECEIPT_VERSION, CAPTURE_STAGING_FILE, } from "./constants.js";
import { captureDirectory, eventPath, identifierHash, receiptPath, validateIdentifier, validateIntegration, } from "./paths.js";
import { ensurePrivateDirectory, publishExclusive, readPrivateFile } from "./utils/atomic-file.js";
import { canonicalJson, canonicalValue } from "./utils/serialization.js";
import { listPrivateDirectory } from "../../utils/files/private-directory.js";
import { requireNonNegativeInteger, requireSafeEpochMilliseconds, } from "../../utils/validation/objects.js";
export function createCaptureStore(root) {
    const storageRoot = resolve(root);
    return {
        async capture(input) {
            let record;
            let contents;
            try {
                validateScope(input);
                const dependencies = normalizeDependencies(input.dependencies, input);
                validateIdentifier(input.runId, "run ID");
                validateIdentifier(input.destinationFingerprint, "destination fingerprint");
                validateIdentifier(input.eventKind, "event kind");
                record = {
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
                    ...(input.priorDeliveryAttempts === undefined
                        ? {}
                        : {
                            priorDeliveryAttempts: requireNonNegativeInteger(input.priorDeliveryAttempts, "Prior delivery attempts"),
                        }),
                    ...(dependencies === undefined ? {} : { dependencies }),
                };
                contents = canonicalJson(record);
            }
            catch (error) {
                return failure("SERIALIZATION_FAILED", error);
            }
            try {
                const path = eventPath(storageRoot, input);
                await ensureDirectories(input.integration, input.sessionId, input.turnId, "events");
                if (await publishExclusive(path, contents))
                    return { status: "published", record };
                const previous = await readRecord(storageRoot, path);
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
            }
            catch (error) {
                return failure("STORAGE_FAILED", error);
            }
        },
        async read(scope) {
            validateScope(scope);
            const record = await readRecord(storageRoot, eventPath(storageRoot, scope));
            if (record === undefined)
                return undefined;
            if (!sameScope(record, scope))
                throw new Error("Capture namespace does not match");
            return record;
        },
        async enumerate(integration, sessionId) {
            validateIntegration(integration);
            validateIdentifier(sessionId, "session ID");
            const turnsDirectory = join(captureDirectory(storageRoot), "integrations", integration, "sessions", identifierHash(sessionId), "turns");
            const turns = await listPrivateDirectory(storageRoot, turnsDirectory);
            if (turns === undefined)
                return [];
            const captures = [];
            for (const turn of turns) {
                if (!turn.isDirectory() || turn.isSymbolicLink() || !CAPTURE_HASH.test(turn.name))
                    throw new Error("Invalid capture turn directory");
                const eventDirectory = join(turnsDirectory, turn.name, "events");
                const events = await listPrivateDirectory(storageRoot, eventDirectory);
                if (events === undefined)
                    continue;
                for (const event of events) {
                    if (event.isSymbolicLink() || !event.isFile())
                        throw new Error("Capture event must be a regular file");
                    if (CAPTURE_STAGING_FILE.test(event.name))
                        continue;
                    if (!CAPTURE_EVENT_FILE.test(event.name))
                        throw new Error("Invalid capture event path");
                    const path = join(eventDirectory, event.name);
                    const record = await readRecord(storageRoot, path);
                    if (record === undefined ||
                        record.integration !== integration ||
                        record.sessionId !== sessionId ||
                        identifierHash(record.turnId) !== turn.name ||
                        `${identifierHash(record.eventId)}.json` !== event.name) {
                        throw new Error("Capture event namespace does not match");
                    }
                    const info = await lstat(path);
                    if (!info.isFile() || info.isSymbolicLink() || !Number.isFinite(info.mtimeMs))
                        throw new Error("Capture event must be a regular file");
                    captures.push({ record, capturedAtMs: record.capturedAtMs });
                }
            }
            return captures.toSorted(compareCaptures);
        },
        async enumerateTurn(integration, sessionId, turnId) {
            return enumerateTurnCaptures(storageRoot, integration, sessionId, turnId);
        },
        async enumerateSessions(integration) {
            validateIntegration(integration);
            const sessionsDirectory = join(captureDirectory(storageRoot), "integrations", integration, "sessions");
            const directories = await listPrivateDirectory(storageRoot, sessionsDirectory);
            if (directories === undefined)
                return [];
            const sessions = [];
            for (const directory of directories) {
                if (!directory.isDirectory() ||
                    directory.isSymbolicLink() ||
                    !CAPTURE_HASH.test(directory.name)) {
                    throw new Error("Invalid capture session directory");
                }
                const session = await enumerateSession(storageRoot, integration, directory.name);
                if (session === undefined || session.captures.length === 0)
                    continue;
                sessions.push(session);
            }
            return sessions.toSorted((left, right) => left.sessionId === right.sessionId ? 0 : left.sessionId < right.sessionId ? -1 : 1);
        },
        async recordOutcome(input) {
            try {
                validateScope(input);
                validateIdentifier(input.destination, "destination");
                if (input.outcome !== "delivered" && input.outcome !== "dropped")
                    throw new TypeError("Invalid outcome");
                if (input.reason !== undefined)
                    validateIdentifier(input.reason, "outcome reason");
                if ((await this.read(input)) === undefined)
                    return { status: "missing-capture" };
                const path = receiptPath(storageRoot, input, input.destination);
                await ensureDirectories(input.integration, input.sessionId, input.turnId, "receipts", input.destination);
                const comparable = receiptValue(input, new Date().toISOString());
                const contents = canonicalJson(comparable);
                if (await publishExclusive(path, contents))
                    return { status: "recorded", receipt: comparable };
                const previous = await readReceipt(storageRoot, path);
                if (previous === undefined)
                    return {
                        status: "failed",
                        code: "STORAGE_FAILED",
                        message: "Published receipt disappeared",
                    };
                return sameReceipt(previous, input)
                    ? { status: "duplicate", receipt: previous }
                    : { status: "conflict" };
            }
            catch (error) {
                return failure("STORAGE_FAILED", error);
            }
        },
        async readOutcome(scope, destination) {
            try {
                validateScope(scope);
                validateIdentifier(destination, "destination");
                if ((await this.read(scope)) === undefined)
                    return { status: "missing-capture" };
                const receipt = await readReceipt(storageRoot, receiptPath(storageRoot, scope, destination));
                if (receipt === undefined)
                    return { status: "pending" };
                return sameScope(receipt, scope) && receipt.destination === destination
                    ? { status: "settled", receipt }
                    : {
                        status: "failed",
                        code: "STORAGE_FAILED",
                        message: "Receipt namespace does not match",
                    };
            }
            catch (error) {
                return failure("STORAGE_FAILED", error);
            }
        },
    };
    async function ensureDirectories(integration, sessionId, turnId, collection, destination) {
        const pathSegments = [
            CAPTURE_DIRECTORY,
            "integrations",
            integration,
            "sessions",
            identifierHash(sessionId),
            "turns",
            identifierHash(turnId),
            collection,
        ];
        if (destination !== undefined)
            pathSegments.push(identifierHash(destination));
        await ensurePrivateDirectory(storageRoot, pathSegments);
    }
}
function compareCaptures(left, right) {
    if (left.capturedAtMs !== right.capturedAtMs)
        return left.capturedAtMs < right.capturedAtMs ? -1 : 1;
    if (left.record.eventId === right.record.eventId)
        return 0;
    return left.record.eventId < right.record.eventId ? -1 : 1;
}
async function enumerateTurnCaptures(root, integration, sessionId, turnId) {
    validateIntegration(integration);
    validateIdentifier(sessionId, "session ID");
    validateIdentifier(turnId, "turn ID");
    const turnsDirectory = join(captureDirectory(root), "integrations", integration, "sessions", identifierHash(sessionId), "turns");
    const turns = await listPrivateDirectory(root, turnsDirectory);
    if (turns === undefined)
        return [];
    const turnHash = identifierHash(turnId);
    const turn = turns.find((entry) => entry.name === turnHash);
    if (turn === undefined)
        return [];
    if (!turn.isDirectory() || turn.isSymbolicLink())
        throw new Error("Invalid capture turn directory");
    const eventDirectory = join(turnsDirectory, turnHash, "events");
    const events = await listPrivateDirectory(root, eventDirectory);
    if (events === undefined)
        return [];
    const captures = [];
    for (const event of events) {
        if (event.isSymbolicLink() || !event.isFile())
            throw new Error("Capture event must be a regular file");
        if (CAPTURE_STAGING_FILE.test(event.name))
            continue;
        if (!CAPTURE_EVENT_FILE.test(event.name))
            throw new Error("Invalid capture event path");
        const path = join(eventDirectory, event.name);
        const record = await readRecord(root, path);
        if (record === undefined ||
            record.integration !== integration ||
            record.sessionId !== sessionId ||
            record.turnId !== turnId ||
            `${identifierHash(record.eventId)}.json` !== event.name) {
            throw new Error("Capture event namespace does not match");
        }
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || !Number.isFinite(info.mtimeMs))
            throw new Error("Capture event must be a regular file");
        captures.push({ record, capturedAtMs: record.capturedAtMs });
    }
    return captures.toSorted(compareCaptures);
}
async function enumerateSession(root, integration, sessionHash) {
    const turnsDirectory = join(captureDirectory(root), "integrations", integration, "sessions", sessionHash, "turns");
    const turns = await listPrivateDirectory(root, turnsDirectory);
    if (turns === undefined)
        return undefined;
    const captures = [];
    let sessionId;
    for (const turn of turns) {
        if (!turn.isDirectory() || turn.isSymbolicLink() || !CAPTURE_HASH.test(turn.name))
            throw new Error("Invalid capture turn directory");
        const eventDirectory = join(turnsDirectory, turn.name, "events");
        const events = await listPrivateDirectory(root, eventDirectory);
        if (events === undefined)
            continue;
        for (const event of events) {
            if (event.isSymbolicLink() || !event.isFile())
                throw new Error("Capture event must be a regular file");
            if (CAPTURE_STAGING_FILE.test(event.name))
                continue;
            if (!CAPTURE_EVENT_FILE.test(event.name))
                throw new Error("Invalid capture event path");
            const path = join(eventDirectory, event.name);
            const record = await readRecord(root, path);
            if (record === undefined ||
                record.integration !== integration ||
                identifierHash(record.sessionId) !== sessionHash ||
                identifierHash(record.turnId) !== turn.name ||
                `${identifierHash(record.eventId)}.json` !== event.name ||
                (sessionId !== undefined && record.sessionId !== sessionId)) {
                throw new Error("Capture event namespace does not match");
            }
            sessionId = record.sessionId;
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || !Number.isFinite(info.mtimeMs))
                throw new Error("Capture event must be a regular file");
            captures.push({ record, capturedAtMs: record.capturedAtMs });
        }
    }
    if (sessionId === undefined)
        return undefined;
    return { sessionId, captures: captures.toSorted(compareCaptures) };
}
function sameCapture(left, right) {
    const leftContent = { ...left };
    const rightContent = { ...right };
    delete leftContent.capturedAtMs;
    delete rightContent.capturedAtMs;
    return canonicalJson(leftContent) === canonicalJson(rightContent);
}
function receiptValue(input, recordedAt) {
    return {
        version: CAPTURE_RECEIPT_VERSION,
        integration: input.integration,
        sessionId: input.sessionId,
        turnId: input.turnId,
        eventId: input.eventId,
        destination: input.destination,
        outcome: input.outcome,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        recordedAt,
    };
}
async function readRecord(root, path) {
    const contents = await readPrivateFile(root, path);
    if (contents === undefined)
        return undefined;
    const value = parseObject(contents);
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
        throw new Error("Unsupported capture record");
    }
    if ("sourceAgeStartedAtMs" in value) {
        requireSafeEpochMilliseconds(value["sourceAgeStartedAtMs"], "Stored source age");
    }
    if ("priorDeliveryAttempts" in value)
        requireNonNegativeInteger(value["priorDeliveryAttempts"], "Stored prior delivery attempts");
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
    return {
        ...value,
        ...(dependencies === undefined ? {} : { dependencies }),
    };
}
async function readReceipt(root, path) {
    const contents = await readPrivateFile(root, path);
    if (contents === undefined)
        return undefined;
    const value = parseObject(contents);
    if (value.version !== CAPTURE_RECEIPT_VERSION ||
        typeof value.integration !== "string" ||
        typeof value.sessionId !== "string" ||
        typeof value.turnId !== "string" ||
        typeof value.eventId !== "string" ||
        typeof value.destination !== "string" ||
        (value.outcome !== "delivered" && value.outcome !== "dropped") ||
        typeof value.recordedAt !== "string" ||
        ("reason" in value && typeof value.reason !== "string")) {
        throw new Error("Unsupported outcome receipt");
    }
    validateIdentifier(value.destination, "destination");
    if ("reason" in value)
        validateIdentifier(value.reason, "outcome reason");
    const recordedAt = new Date(value.recordedAt);
    if (!Number.isFinite(recordedAt.getTime()) || recordedAt.toISOString() !== value.recordedAt)
        throw new Error("Unsupported outcome receipt");
    return value;
}
function parseObject(contents) {
    const value = JSON.parse(contents);
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid storage record");
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
        throw new TypeError("Invalid capture dependencies");
    const seen = new Set();
    return value.map((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item))
            throw new TypeError("Invalid capture dependency");
        const candidate = item;
        if (typeof candidate.integration !== "string" ||
            typeof candidate.sessionId !== "string" ||
            typeof candidate.turnId !== "string" ||
            typeof candidate.eventId !== "string") {
            throw new TypeError("Invalid capture dependency");
        }
        const dependency = {
            integration: candidate.integration,
            sessionId: candidate.sessionId,
            turnId: candidate.turnId,
            eventId: candidate.eventId,
        };
        validateScope(dependency);
        if (dependency.integration !== dependent.integration)
            throw new TypeError("Capture dependencies must use the same integration");
        if (sameScope(dependency, dependent))
            throw new TypeError("Capture cannot depend on itself");
        const key = canonicalJson(dependency);
        if (seen.has(key))
            throw new TypeError("Capture dependencies must be unique");
        seen.add(key);
        return dependency;
    });
}
function sameScope(record, scope) {
    return (record.integration === scope.integration &&
        record.sessionId === scope.sessionId &&
        record.turnId === scope.turnId &&
        record.eventId === scope.eventId);
}
function sameReceipt(receipt, input) {
    return (sameScope(receipt, input) &&
        receipt.destination === input.destination &&
        receipt.outcome === input.outcome &&
        receipt.reason === input.reason);
}
function failure(code, error) {
    return {
        status: "failed",
        code: errorCode(error) ?? code,
        message: error instanceof Error ? error.message : String(error),
    };
}
function errorCode(error) {
    return error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : undefined;
}
//# sourceMappingURL=capture-store.js.map