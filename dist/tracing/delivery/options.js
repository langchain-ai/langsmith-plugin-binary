import { validateIdentifier } from "../../storage/capture/paths.js";
import { DELIVERY_BATCH_LIMITS_INVALID_MESSAGE, DELIVERY_DEFAULT_MAX_AGE_MS, DELIVERY_DEFAULT_MAX_ENTRIES, DELIVERY_DESTINATION_DUPLICATE_MESSAGE, DELIVERY_DESTINATION_INVALID_MESSAGE, DELIVERY_DESTINATION_REQUIRED_MESSAGE, DELIVERY_POLICY_INVALID_MESSAGE, DELIVERY_QUICK_RETRY_MS, DELIVERY_RETRY_BASE_MS, DELIVERY_TRANSPORT_REQUIRED_MESSAGE, DELIVERY_WRITER_REQUIRED_MESSAGE, } from "./constants.js";
export function validateDrainRequest(request) {
    if (request.writer === null || typeof request.writer !== "object")
        throw new TypeError(DELIVERY_WRITER_REQUIRED_MESSAGE);
    validateIdentifier(request.writer.accountFingerprint, "account fingerprint");
    if (!Array.isArray(request.writer.destinations) || request.writer.destinations.length === 0)
        throw new TypeError(DELIVERY_DESTINATION_REQUIRED_MESSAGE);
    const ids = new Set();
    for (const destination of request.writer.destinations) {
        validateIdentifier(destination.id, "destination");
        if (ids.has(destination.id))
            throw new TypeError(DELIVERY_DESTINATION_DUPLICATE_MESSAGE);
        ids.add(destination.id);
    }
    if (typeof request.writer.sendBatch !== "function")
        throw new TypeError(DELIVERY_TRANSPORT_REQUIRED_MESSAGE);
}
export function snapshotWriter(writer) {
    if (writer === null || typeof writer !== "object")
        throw new TypeError(DELIVERY_WRITER_REQUIRED_MESSAGE);
    const accountFingerprint = writer.accountFingerprint;
    const sourceDestinations = writer.destinations;
    const sendBatch = writer.sendBatch;
    const batchLimits = writer.batchLimits;
    if (!Array.isArray(sourceDestinations) || sourceDestinations.length === 0)
        throw new TypeError(DELIVERY_DESTINATION_REQUIRED_MESSAGE);
    const destinations = sourceDestinations.map((destination) => {
        if (destination === null || typeof destination !== "object")
            throw new TypeError(DELIVERY_DESTINATION_INVALID_MESSAGE);
        return Object.freeze({ id: destination.id });
    });
    return Object.freeze({
        accountFingerprint,
        destinations: Object.freeze(destinations),
        sendBatch: typeof sendBatch === "function" ? sendBatch.bind(writer) : sendBatch,
        batchLimits: Object.freeze({ ...validBatchLimits(batchLimits) }),
    });
}
function validBatchLimits(limits) {
    if (limits === null || typeof limits !== "object")
        throw new TypeError(DELIVERY_BATCH_LIMITS_INVALID_MESSAGE);
    if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1 || !(limits.maxBytes > 0))
        throw new TypeError(DELIVERY_BATCH_LIMITS_INVALID_MESSAGE);
    return { maxRecords: limits.maxRecords, maxBytes: limits.maxBytes };
}
export function resolvePolicy(policy) {
    const resolved = {
        maxAgeMs: policy?.maxAgeMs ?? DELIVERY_DEFAULT_MAX_AGE_MS,
        maxEntries: policy?.maxEntries ?? DELIVERY_DEFAULT_MAX_ENTRIES,
        retryBaseMs: policy?.retryBaseMs ?? DELIVERY_RETRY_BASE_MS,
        quickRetryMs: policy?.quickRetryMs ?? DELIVERY_QUICK_RETRY_MS,
    };
    if (!Number.isSafeInteger(resolved.maxAgeMs) ||
        resolved.maxAgeMs <= 0 ||
        !Number.isSafeInteger(resolved.maxEntries) ||
        resolved.maxEntries <= 0 ||
        !Number.isSafeInteger(resolved.retryBaseMs) ||
        resolved.retryBaseMs < 0 ||
        !Number.isSafeInteger(resolved.quickRetryMs) ||
        resolved.quickRetryMs < 0) {
        throw new TypeError(DELIVERY_POLICY_INVALID_MESSAGE);
    }
    return resolved;
}
//# sourceMappingURL=options.js.map