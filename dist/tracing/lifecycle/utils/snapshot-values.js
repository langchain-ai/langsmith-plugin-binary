import { createHash } from "node:crypto";
import { canonicalJson } from "../../../storage/capture/utils/serialization.js";
import { canonicalJsonValue, ownDataField, requireNonBlankString, requireOwnDataField, requirePlainRecord, } from "../../../utils/validation/objects.js";
import { normalizedRedactedFields } from "../../upload/redaction.js";
import { UPLOAD_PATCH_FIELDS } from "../../upload/constants.js";
import { statusForPost as runPrivacyStatus } from "./validation.js";
import { LIFECYCLE_SNAPSHOT_OPTIONAL_RUN_FIELDS } from "../constants.js";
export function payloadObject(record) {
    return requirePlainRecord(record.normalizedPayload, "Stored run payload");
}
export function readPrivacyMode(payload) {
    const value = requireOwnDataField(payload, "privacyMode");
    if (value !== "full" && value !== "metadata")
        throw new TypeError("Stored privacy mode is invalid");
    return value;
}
export function storedRun(payload, runId) {
    const run = canonicalJsonValue(requireOwnDataField(payload, "run"));
    const source = requirePlainRecord(run, "Stored run snapshot");
    if (source["id"] !== runId)
        throw new TypeError("Stored run ID does not match its capture");
    requireNonBlankString(source["name"], "Run name");
    requireNonBlankString(source["run_type"], "Run type");
    return source;
}
export function storedRedactedFields(payload) {
    const field = ownDataField(payload, "redactedFields");
    return normalizedRedactedFields(field.present ? field.value : undefined);
}
export function storedPrivacyStatus(payload, run, privacyMode) {
    if (privacyMode === "metadata")
        return readPrivacyStatus(requireOwnDataField(payload, "privacyContext"));
    return runPrivacyStatus(run);
}
export function readPrivacyStatus(value) {
    const context = requirePlainRecord(value, "Run privacy context");
    const status = requireOwnDataField(context, "status");
    if (status !== "running" && status !== "completed" && status !== "error") {
        throw new TypeError("Invalid run privacy status");
    }
    return status;
}
export function applySnapshotOmissions(current, previous, sourceRun) {
    const result = { ...current };
    const resultFields = result;
    const previousFields = previous;
    for (const field of LIFECYCLE_SNAPSHOT_OPTIONAL_RUN_FIELDS) {
        const supplied = ownDataField(sourceRun, field);
        if (supplied.present && supplied.value !== undefined)
            continue;
        const oldValue = ownDataField(previousFields, field);
        if (oldValue.present)
            resultFields[field] = oldValue.value;
        else
            delete resultFields[field];
    }
    return result;
}
export function snapshotPatchFields(previous, current, inputOutputStates, sourceRun) {
    const previousFields = previous;
    const currentFields = current;
    return [...UPLOAD_PATCH_FIELDS].filter((field) => {
        if (field === "inputs" || field === "outputs") {
            return changedContentField(previousFields, currentFields, sourceRun, field, inputOutputStates[field]);
        }
        const oldValue = ownDataField(previousFields, field);
        const nextValue = ownDataField(currentFields, field);
        if (oldValue.present !== nextValue.present)
            return true;
        return oldValue.present && nextValue.present && !sameCanonical(oldValue.value, nextValue.value);
    });
}
export function presentFieldState(value, field) {
    return Object.hasOwn(value, field) ? { state: "preserve" } : { state: "absent" };
}
function fieldDigest(value) {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function sameRunIdentity(left, right) {
    return (left.id === right.id &&
        left.name === right.name &&
        left.run_type === right.run_type &&
        sameTimestamp(left.start_time, right.start_time) &&
        left.parent_run_id === right.parent_run_id &&
        left.trace_id === right.trace_id &&
        left.dotted_order === right.dotted_order);
}
function sameTimestamp(left, right) {
    if (left === undefined || right === undefined)
        return left === right;
    return new Date(left).getTime() === new Date(right).getTime();
}
export function runContext(record) {
    const { id, name, run_type, start_time, parent_run_id, trace_id, dotted_order } = storedRun(payloadObject(record), record.runId);
    return {
        id,
        name,
        run_type,
        ...(start_time === undefined ? {} : { start_time }),
        ...(parent_run_id === undefined ? {} : { parent_run_id }),
        ...(trace_id === undefined ? {} : { trace_id }),
        ...(dotted_order === undefined ? {} : { dotted_order }),
    };
}
export function captureScope(record) {
    const { integration, sessionId, turnId, eventId } = record;
    return { integration, sessionId, turnId, eventId };
}
export function sameCanonical(left, right) {
    return canonicalJson(left) === canonicalJson(right);
}
function changedContentField(previous, current, sourceRun, field, state) {
    const previousValue = ownDataField(previous, field);
    const nextValue = ownDataField(current, field);
    switch (state.state) {
        case "value":
            if (field === "outputs" && !ownDataField(sourceRun, field).present)
                return false;
            return nextValue.present && fieldDigest(nextValue.value) !== state.digest;
        case "absent":
            return nextValue.present;
        case "preserve":
            return (previousValue.present !== nextValue.present ||
                (previousValue.present &&
                    nextValue.present &&
                    !sameCanonical(previousValue.value, nextValue.value)));
    }
}
export function snapshotPatchValues(sourceRun, fields) {
    const values = {};
    for (const field of fields) {
        const value = ownDataField(sourceRun, field);
        if (!value.present || value.value === undefined)
            return undefined;
        values[field] = value.value;
    }
    return values;
}
export function readStoredPatchValues(fields, values) {
    const selected = {};
    for (const field of fields) {
        if (!UPLOAD_PATCH_FIELDS.has(field) ||
            Object.hasOwn(selected, field))
            return undefined;
        const value = ownDataField(values, field);
        if (!value.present || value.value === undefined)
            return undefined;
        selected[field] = value.value;
    }
    return selected;
}
//# sourceMappingURL=snapshot-values.js.map