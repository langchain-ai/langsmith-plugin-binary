import { createHash } from "node:crypto";
import { CAPTURE_COMPACTED_RECORD_VERSION, CAPTURE_HASH } from "./constants.js";
import { canonicalJson, canonicalValue } from "./utils/serialization.js";
export function captureContentDigest(record) {
    if ("compaction" in record && record.compaction !== undefined)
        return record.compaction.originalContentDigest;
    const content = { ...record };
    delete content.version;
    delete content.capturedAtMs;
    delete content.compaction;
    return createHash("sha256").update(canonicalJson(content)).digest("hex");
}
export function compactCaptureRecord(record, originalContentDigest) {
    const normalizedPayload = compactPayload(record);
    if (normalizedPayload === undefined)
        return undefined;
    return {
        ...record,
        version: CAPTURE_COMPACTED_RECORD_VERSION,
        normalizedPayload: normalizedPayload.value,
        compaction: {
            version: 1,
            originalContentDigest,
            fields: normalizedPayload.fields,
        },
    };
}
export function validateCompactionMarker(value, eventKind, normalizedPayload) {
    if (!isObjectRecord(value) ||
        !hasExactKeys(value, ["version", "originalContentDigest", "fields"])) {
        throw new Error("Invalid compacted capture marker");
    }
    if (value.version !== 1 ||
        typeof value.originalContentDigest !== "string" ||
        !CAPTURE_HASH.test(value.originalContentDigest) ||
        !isObjectRecord(value.fields) ||
        !hasExactKeys(value.fields, ["inputs", "outputs"])) {
        throw new Error("Invalid compacted capture marker");
    }
    const payload = isJsonObject(normalizedPayload) ? normalizedPayload : undefined;
    if (payload === undefined)
        throw new Error("Invalid compacted capture payload");
    let target;
    let patchFields;
    if (eventKind === "run-post" && payload.operation === "post" && isJsonObject(payload.run)) {
        target = payload.run;
    }
    else if (eventKind === "run-patch" &&
        payload.operation === "patch" &&
        isJsonObject(payload.patch) &&
        isJsonObject(payload.patch.values) &&
        Array.isArray(payload.patch.fields) &&
        payload.patch.fields.every((field) => typeof field === "string")) {
        target = payload.patch.values;
        patchFields = payload.patch.fields;
    }
    else {
        throw new Error("Invalid compacted capture payload");
    }
    const fields = {
        inputs: readCompactedField(value.fields.inputs),
        outputs: readCompactedField(value.fields.outputs),
    };
    if (![fields.inputs, fields.outputs].some((field) => field.state === "value"))
        throw new Error("Compacted capture marker has no removed fields");
    for (const field of ["inputs", "outputs"]) {
        const state = fields[field];
        const present = Object.hasOwn(target, field);
        const included = patchFields?.includes(field);
        if ((state.state === "preserve" ? !present : present) ||
            (included !== undefined && (state.state === "preserve") !== included)) {
            throw new Error("Compacted capture field does not match its marker");
        }
    }
    return {
        version: 1,
        originalContentDigest: value.originalContentDigest,
        fields,
    };
}
function compactPayload(record) {
    if (record.eventKind !== "run-post" && record.eventKind !== "run-patch")
        return undefined;
    const payloadValue = canonicalValue(record.normalizedPayload, new Set());
    if (!isJsonObject(payloadValue))
        return undefined;
    const fields = {
        inputs: { state: "absent" },
        outputs: { state: "absent" },
    };
    let compactedAny = false;
    if (record.eventKind === "run-post") {
        if (payloadValue.operation !== "post" || !isJsonObject(payloadValue.run))
            return undefined;
        for (const field of ["inputs", "outputs"]) {
            if (Object.hasOwn(payloadValue.run, field)) {
                fields[field] = { state: "value", digest: valueDigest(payloadValue.run[field]) };
                delete payloadValue.run[field];
                compactedAny = true;
            }
        }
    }
    else {
        if (payloadValue.operation !== "patch" || !isJsonObject(payloadValue.patch))
            return undefined;
        if (!Array.isArray(payloadValue.patch.fields) || !isJsonObject(payloadValue.patch.values))
            return undefined;
        const patchFields = payloadValue.patch.fields;
        if (patchFields.some((field) => typeof field !== "string") ||
            new Set(patchFields).size !== patchFields.length) {
            return undefined;
        }
        for (const field of ["inputs", "outputs"]) {
            const included = patchFields.includes(field);
            const present = Object.hasOwn(payloadValue.patch.values, field);
            if (included !== present)
                return undefined;
            if (present) {
                fields[field] = {
                    state: "value",
                    digest: valueDigest(payloadValue.patch.values[field]),
                };
                delete payloadValue.patch.values[field];
                compactedAny = true;
            }
        }
        payloadValue.patch.fields = patchFields.filter((field) => field !== "inputs" && field !== "outputs");
    }
    return compactedAny ? { value: payloadValue, fields } : undefined;
}
function readCompactedField(value) {
    if (!isObjectRecord(value) || typeof value.state !== "string")
        throw new Error("Invalid compacted capture field");
    if (value.state === "preserve" && hasExactKeys(value, ["state"]))
        return { state: "preserve" };
    if (value.state === "absent" && hasExactKeys(value, ["state"]))
        return { state: "absent" };
    if (value.state === "value" &&
        hasExactKeys(value, ["state", "digest"]) &&
        typeof value.digest === "string" &&
        CAPTURE_HASH.test(value.digest)) {
        return { state: "value", digest: value.digest };
    }
    throw new Error("Invalid compacted capture field");
}
function isJsonObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isObjectRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    if (Object.keys(value).length !== keys.length)
        return false;
    const expected = new Set(keys);
    return Object.keys(value).every((key) => expected.has(key));
}
function valueDigest(value) {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
//# sourceMappingURL=compaction.js.map