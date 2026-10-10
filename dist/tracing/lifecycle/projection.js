import { buildCodingAgentMetadata, prepareCodingAgentMetadataProvenance, } from "../../metadata/index.js";
import { createCodingAgentRunTree, survivingCodingAgentPatchFields, } from "../../privacy/index.js";
import { canonicalJsonArray, canonicalJsonObject, ownDataField, requireNonBlankString, requireOwnDataField, requirePlainRecord, requireString, requireStringArray, requireTimestamp, } from "../../utils/validation/objects.js";
import { UPLOAD_PATCH_FIELDS } from "../upload/constants.js";
import { createRunIdentity } from "./identity.js";
export function projectSubmission(value, integration, priorIdentity) {
    const source = requirePlainRecord(value, "Prepared run submission");
    if (requireOwnDataField(source, "integration") !== integration) {
        throw new TypeError("Run integration does not match the lifecycle bridge");
    }
    const privacyMode = requireOwnDataField(source, "privacyMode");
    if (privacyMode !== "full" && privacyMode !== "metadata")
        throw new TypeError("Invalid privacy mode");
    const operation = requireOwnDataField(source, "operation");
    if (operation !== "post" && operation !== "patch")
        throw new TypeError("Invalid run operation");
    if (operation === "post") {
        const run = canonicalIdentity(normalizedRunSnapshot(requireOwnDataField(source, "run")), priorIdentity);
        const suppliedPrivacyContext = ownDataField(source, "privacyContext");
        const status = run.error !== undefined
            ? "error"
            : suppliedPrivacyContext.present
                ? privacyStatus(suppliedPrivacyContext.value).status
                : statusForPost(run);
        const metadata = prepareCodingAgentMetadataProvenance(requireOwnDataField(source, "metadata"), integration, privacyMode, status);
        if (metadata.status === "deferred")
            return metadata;
        const projected = {
            payload: {
                operation,
                integration,
                privacyMode,
                ...(privacyMode === "metadata" ? { privacyContext: { status } } : {}),
                run: privacyMode === "metadata" ? projectPost(run, metadata.value, status) : run,
            },
            metadata: metadata.value,
        };
        return { status: "ready", value: projected };
    }
    const run = canonicalIdentity(normalizedRunContext(requireOwnDataField(source, "run")), priorIdentity, true);
    const patch = normalizedPatch(requireOwnDataField(source, "patch"));
    const privacyContext = privacyStatus(requireOwnDataField(source, "privacyContext"));
    const metadata = prepareCodingAgentMetadataProvenance(requireOwnDataField(source, "metadata"), integration, privacyMode, privacyContext.status);
    if (metadata.status === "deferred")
        return metadata;
    const projected = {
        payload: {
            operation,
            integration,
            privacyMode,
            run,
            privacyContext,
            patch: privacyMode === "metadata"
                ? projectPatch(run, patch, integration, metadata.value, privacyContext)
                : patch,
        },
        metadata: metadata.value,
    };
    return { status: "ready", value: projected };
}
function projectPost(run, metadata, status) {
    const tree = createCodingAgentRunTree({
        id: run.id,
        name: run.name,
        run_type: run.run_type,
        ...(run.start_time === undefined ? {} : { start_time: run.start_time }),
        inputs: run.inputs,
        extra: { metadata: buildCodingAgentMetadata(metadata) },
        ...(run.end_time === undefined ? {} : { end_time: run.end_time }),
        ...(run.outputs === undefined ? {} : { outputs: run.outputs }),
        ...(run.parent_run_id === undefined ? {} : { parent_run_id: run.parent_run_id }),
        ...(run.trace_id === undefined ? {} : { trace_id: run.trace_id }),
        ...(run.dotted_order === undefined ? {} : { dotted_order: run.dotted_order }),
        ...(run.error === undefined ? {} : { error: run.error }),
        ...(run.tags === undefined ? {} : { tags: run.tags }),
        ...(run.serialized === undefined ? {} : { serialized: run.serialized }),
        ...(run.reference_example_id === undefined
            ? {}
            : { reference_example_id: run.reference_example_id }),
    }, metadata.integration, "metadata", { status });
    if (run.events !== undefined)
        tree.events = run.events;
    const projected = tree.toJSON();
    return {
        id: run.id,
        name: run.name,
        run_type: run.run_type,
        start_time: requireTimestamp(run.start_time),
        inputs: canonicalJsonObject(projected["inputs"], "Projected run inputs"),
        outputs: canonicalJsonObject(projected["outputs"], "Projected run outputs"),
        ...(run.end_time === undefined ? {} : { end_time: run.end_time }),
        ...(run.parent_run_id === undefined ? {} : { parent_run_id: run.parent_run_id }),
        ...(run.trace_id === undefined ? {} : { trace_id: run.trace_id }),
        ...(run.dotted_order === undefined ? {} : { dotted_order: run.dotted_order }),
    };
}
function projectPatch(context, patch, integration, metadata, privacyContext) {
    const tree = createCodingAgentRunTree({
        id: context.id,
        name: context.name,
        run_type: context.run_type,
        ...(context.start_time === undefined ? {} : { start_time: context.start_time }),
        inputs: patch.values.inputs ?? {},
        outputs: patch.values.outputs ?? {},
        extra: { metadata: buildCodingAgentMetadata(metadata) },
        ...(context.parent_run_id === undefined ? {} : { parent_run_id: context.parent_run_id }),
        ...(context.trace_id === undefined ? {} : { trace_id: context.trace_id }),
        ...(context.dotted_order === undefined ? {} : { dotted_order: context.dotted_order }),
        ...(patch.values.end_time === undefined ? {} : { end_time: patch.values.end_time }),
        ...(patch.values.error === undefined ? {} : { error: patch.values.error }),
        ...(patch.values.tags === undefined ? {} : { tags: patch.values.tags }),
        ...(patch.values.serialized === undefined ? {} : { serialized: patch.values.serialized }),
        ...(patch.values.reference_example_id === undefined
            ? {}
            : { reference_example_id: patch.values.reference_example_id }),
    }, integration, "metadata", privacyContext);
    if (patch.values.events !== undefined)
        tree.events = patch.values.events;
    const projected = tree.toJSON();
    const fields = survivingCodingAgentPatchFields(projected, patch.fields);
    const values = {};
    for (const field of fields) {
        const value = ownDataField(projected, field);
        if (!value.present)
            continue;
        values[field] =
            field === "inputs" || field === "outputs"
                ? canonicalJsonObject(value.value, `Projected patch ${field}`)
                : field === "tags"
                    ? requireStringArray(value.value, `Projected patch ${field}`)
                    : field === "events"
                        ? canonicalJsonArray(value.value, `Projected patch ${field}`)
                        : field === "error" || field === "reference_example_id"
                            ? requireString(value.value, `Projected patch ${field}`)
                            : field === "end_time"
                                ? requireTimestamp(value.value)
                                : canonicalJsonObject(value.value, `Projected patch ${field}`);
    }
    return { fields: fields.filter((field) => Object.hasOwn(values, field)), values };
}
function normalizedRunSnapshot(value) {
    const source = requirePlainRecord(value, "Normalized run snapshot");
    const run = {
        id: requiredText(source, "id", "Run ID"),
        name: requiredText(source, "name", "Run name"),
        run_type: requiredText(source, "run_type", "Run type"),
        inputs: canonicalJsonObject(requireOwnDataField(source, "inputs"), "Run inputs"),
    };
    copyRunContext(source, run);
    const endTime = ownDataField(source, "end_time");
    if (endTime.present && endTime.value !== undefined)
        run.end_time = requireTimestamp(endTime.value);
    const outputs = ownDataField(source, "outputs");
    if (outputs.present && outputs.value !== undefined)
        run.outputs = canonicalJsonObject(outputs.value, "Run outputs");
    const tags = ownDataField(source, "tags");
    if (tags.present && tags.value !== undefined)
        run.tags = requireStringArray(tags.value, "Run tags");
    const error = ownDataField(source, "error");
    if (error.present && error.value !== undefined)
        run.error = requireString(error.value, "Run error");
    const serialized = ownDataField(source, "serialized");
    if (serialized.present && serialized.value !== undefined)
        run.serialized = canonicalJsonObject(serialized.value, "Serialized run data");
    const events = ownDataField(source, "events");
    if (events.present && events.value !== undefined)
        run.events = canonicalJsonArray(events.value, "Run events");
    const example = ownDataField(source, "reference_example_id");
    if (example.present && example.value !== undefined) {
        run.reference_example_id = requireNonBlankString(example.value, "Reference example ID");
    }
    return run;
}
function normalizedRunContext(value) {
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
    const start = ownDataField(source, "start_time");
    if (start.present && start.value !== undefined)
        run.start_time = requireTimestamp(start.value);
    for (const [key, name] of [
        ["parent_run_id", "Parent run ID"],
        ["trace_id", "Trace ID"],
        ["dotted_order", "Dotted order"],
    ]) {
        const field = ownDataField(source, key);
        if (field.present && field.value !== undefined)
            run[key] = requireNonBlankString(field.value, name);
    }
}
function canonicalIdentity(run, prior, requireStableIdentity = false) {
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
function normalizedPatch(value) {
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
        values[field] =
            field === "inputs" || field === "outputs"
                ? canonicalJsonObject(selected.value, `Patch ${field}`)
                : field === "end_time"
                    ? requireTimestamp(selected.value)
                    : field === "error"
                        ? requireString(selected.value, "Patch error")
                        : field === "reference_example_id"
                            ? requireNonBlankString(selected.value, "Patch reference example ID")
                            : field === "tags"
                                ? requireStringArray(selected.value, "Patch tags")
                                : field === "events"
                                    ? canonicalJsonArray(selected.value, "Patch events")
                                    : canonicalJsonObject(selected.value, `Patch ${field}`);
    }
    return { fields, values };
}
function privacyStatus(value) {
    const source = requirePlainRecord(value, "Patch privacy context");
    const status = requireOwnDataField(source, "status");
    if (status !== "running" && status !== "completed" && status !== "error") {
        throw new TypeError("Invalid patch privacy status");
    }
    return { status };
}
function statusForPost(run) {
    if (run.error !== undefined)
        return "error";
    if (run.end_time !== undefined)
        return "completed";
    return "running";
}
function requiredText(source, key, name) {
    return requireNonBlankString(requireOwnDataField(source, key), name);
}
//# sourceMappingURL=projection.js.map