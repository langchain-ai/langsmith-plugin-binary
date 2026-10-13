import { buildCodingAgentMetadata, } from "../../metadata/index.js";
import { createCodingAgentRunTree, survivingCodingAgentPatchFields, } from "../../privacy/index.js";
import { canonicalJsonObject, ownDataField, requireTimestamp, } from "../../utils/validation/objects.js";
import { normalizePatchValue } from "./utils/validation.js";
export function projectPost(run, metadata, status) {
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
export function projectPatch(context, patch, integration, metadata, privacyContext) {
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
        values[field] = normalizePatchValue(value.value, field, true);
    }
    return { fields: fields.filter((field) => Object.hasOwn(values, field)), values };
}
//# sourceMappingURL=privacy-projection.js.map