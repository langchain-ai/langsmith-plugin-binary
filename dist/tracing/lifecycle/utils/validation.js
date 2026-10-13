import { canonicalJsonArray, canonicalJsonObject, ownDataField, requireNonBlankString, requireOwnDataField, requirePlainRecord, requireString, requireStringArray, requireTimestamp, } from "../../../utils/validation/objects.js";
import { UPLOAD_PATCH_FIELDS } from "../../upload/constants.js";
import { LIFECYCLE_RUN_CONTEXT_FIELDS } from "../constants.js";
import { createRunIdentity } from "../identity.js";
export function normalizedRunSnapshot(value) {
    const source = requirePlainRecord(value, "Normalized run snapshot");
    const run = {
        id: requiredText(source, "id", "Run ID"),
        name: requiredText(source, "name", "Run name"),
        run_type: requiredText(source, "run_type", "Run type"),
        inputs: canonicalJsonObject(requireOwnDataField(source, "inputs"), "Run inputs"),
    };
    copyRunContext(source, run);
    copyOptionalField(source, run, "end_time", requireTimestamp);
    copyOptionalField(source, run, "outputs", (fieldValue) => canonicalJsonObject(fieldValue, "Run outputs"));
    copyOptionalField(source, run, "tags", (fieldValue) => requireStringArray(fieldValue, "Run tags"));
    copyOptionalField(source, run, "error", (fieldValue) => requireString(fieldValue, "Run error"));
    copyOptionalField(source, run, "serialized", (fieldValue) => canonicalJsonObject(fieldValue, "Serialized run data"));
    copyOptionalField(source, run, "events", (fieldValue) => canonicalJsonArray(fieldValue, "Run events"));
    copyOptionalField(source, run, "reference_example_id", (fieldValue) => requireNonBlankString(fieldValue, "Reference example ID"));
    return run;
}
export function normalizedRunContext(value) {
    const source = requirePlainRecord(value, "Normalized run context");
    const run = {
        id: requiredText(source, "id", "Run ID"),
        name: requiredText(source, "name", "Run name"),
        run_type: requiredText(source, "run_type", "Run type"),
    };
    copyRunContext(source, run);
    return run;
}
function copyRunContext(source, run) {
    copyOptionalField(source, run, "start_time", requireTimestamp);
    for (const [key, name] of LIFECYCLE_RUN_CONTEXT_FIELDS) {
        copyOptionalField(source, run, key, (value) => requireNonBlankString(value, name));
    }
}
export function canonicalIdentity(run, prior, requireStableIdentity = false) {
    const reusable = prior?.id === run.id && prior.parent_run_id === run.parent_run_id ? prior : undefined;
    if (reusable !== undefined &&
        ((run.start_time !== undefined && run.start_time !== reusable.start_time) ||
            (run.trace_id !== undefined && run.trace_id !== reusable.trace_id) ||
            (run.dotted_order !== undefined && run.dotted_order !== reusable.dotted_order))) {
        throw new TypeError("Run identity changed for a persisted capture");
    }
    const knownStartTime = run.start_time ?? reusable?.start_time;
    if (knownStartTime === undefined && requireStableIdentity) {
        throw new TypeError("Patch run context must preserve its canonical start time");
    }
    const startTime = knownStartTime ?? Date.now();
    const result = { ...run, start_time: startTime };
    const canGenerateRootIdentity = !requireStableIdentity && result.parent_run_id === undefined;
    const generatedOrder = canGenerateRootIdentity &&
        result.dotted_order === undefined &&
        reusable?.dotted_order === undefined
        ? createRunIdentity({ id: result.id, start_time: startTime }).dotted_order
        : undefined;
    const traceId = result.trace_id ?? reusable?.trace_id ?? (canGenerateRootIdentity ? result.id : undefined);
    const order = result.dotted_order ?? reusable?.dotted_order ?? generatedOrder;
    if (traceId === undefined || order === undefined) {
        throw new TypeError("Run context must preserve its canonical trace ID and dotted order");
    }
    result.trace_id = traceId;
    result.dotted_order = order;
    return result;
}
export function normalizedPatch(value) {
    const source = requirePlainRecord(value, "Normalized run patch");
    const candidates = canonicalJsonArray(requireOwnDataField(source, "fields"), "Patch field mask");
    const sourceValues = requirePlainRecord(requireOwnDataField(source, "values"), "Patch values");
    const seen = new Set();
    const fields = [];
    const values = {};
    for (const candidate of candidates) {
        if (typeof candidate !== "string" ||
            !UPLOAD_PATCH_FIELDS.has(candidate)) {
            throw new TypeError("Invalid patch field");
        }
        const field = candidate;
        if (seen.has(field))
            throw new TypeError("Patch fields must be unique");
        const selected = ownDataField(sourceValues, field);
        if (!selected.present || selected.value === undefined) {
            throw new TypeError("Every selected patch field must have a value");
        }
        seen.add(field);
        fields.push(field);
        values[field] = normalizePatchValue(selected.value, field);
    }
    return { fields, values };
}
export function privacyStatus(value) {
    const source = requirePlainRecord(value, "Patch privacy context");
    const status = requireOwnDataField(source, "status");
    if (status !== "running" && status !== "completed" && status !== "error") {
        throw new TypeError("Invalid patch privacy status");
    }
    return { status };
}
export function statusForPost(run) {
    if (run.error !== undefined)
        return "error";
    if (run.end_time !== undefined)
        return "completed";
    return "running";
}
function requiredText(source, key, name) {
    return requireNonBlankString(requireOwnDataField(source, key), name);
}
function copyOptionalField(source, target, key, validate) {
    const field = ownDataField(source, String(key));
    if (field.present && field.value !== undefined)
        target[key] = validate(field.value);
}
export function normalizePatchValue(value, field, projected = false) {
    const name = projected ? `Projected patch ${field}` : `Patch ${field}`;
    switch (field) {
        case "end_time":
            return requireTimestamp(value);
        case "error":
            return requireString(value, name);
        case "reference_example_id":
            return projected
                ? requireString(value, name)
                : requireNonBlankString(value, "Patch reference example ID");
        case "tags":
            return requireStringArray(value, name);
        case "events":
            return canonicalJsonArray(value, name);
        default:
            return canonicalJsonObject(value, name);
    }
}
//# sourceMappingURL=validation.js.map