import { CODING_AGENT_INTEGRATION_POLICIES } from "../../metadata/index.js";
import { canonicalJsonObject, ownDataField, requireNonBlankString, requireOwnDataField, requirePlainRecord, requireStringArray, } from "../../utils/validation/objects.js";
import { LIFECYCLE_PATCH_EVENT_KIND, LIFECYCLE_POST_EVENT_KIND, LIFECYCLE_TURN_CLOSURE_STATES, } from "../lifecycle/constants.js";
import { storedAttributionReadiness } from "../lifecycle/closure.js";
import { projectSubmission } from "../lifecycle/projection.js";
export function projectCapture(record, integration) {
    const rawPayload = canonicalJsonObject(record.normalizedPayload, "Stored run payload");
    if (record.compaction?.fields.inputs.state === "value") {
        const run = requirePlainRecord(rawPayload["run"], "Stored compacted run");
        if (!Object.hasOwn(run, "inputs"))
            run["inputs"] = {};
    }
    const submission = projectSubmission({ ...rawPayload, metadata: record.metadataProvenance }, integration);
    if (submission.status === "deferred")
        return undefined;
    const expectedKind = submission.value.payload.operation === "post"
        ? LIFECYCLE_POST_EVENT_KIND
        : LIFECYCLE_PATCH_EVENT_KIND;
    if (record.eventKind !== expectedKind)
        throw new TypeError("Capture event kind does not match its operation");
    const evidence = parseEvidence(record.turnEvidence, storedAttributionReadiness(record, integration));
    return {
        record,
        payload: submission.value.payload,
        metadata: submission.value.metadata,
        open: captureIsOpen(submission.value.payload),
        attributionReady: evidence.attributionReady,
    };
}
function captureIsOpen(payload) {
    if (payload.operation === "post") {
        return payload.run.end_time === undefined && payload.run.error === undefined;
    }
    return payload.privacyContext.status === "running";
}
export function patchPayload(source, metadata, integration, endTime, causalRunError = false) {
    const context = source.payload.run;
    const submission = {
        operation: "patch",
        integration,
        privacyMode: source.payload.privacyMode,
        ...(source.payload.redactedFields === undefined
            ? {}
            : { redactedFields: source.payload.redactedFields }),
        metadata,
        run: {
            id: context.id,
            name: context.name,
            run_type: context.run_type,
            ...(context.start_time === undefined ? {} : { start_time: context.start_time }),
            ...(context.parent_run_id === undefined ? {} : { parent_run_id: context.parent_run_id }),
            ...(context.trace_id === undefined ? {} : { trace_id: context.trace_id }),
            ...(context.dotted_order === undefined ? {} : { dotted_order: context.dotted_order }),
        },
        privacyContext: settlementPrivacyContext(source, endTime, causalRunError),
        patch: settlementPatch(endTime),
    };
    const projected = projectSubmission(submission, integration);
    if (projected.status === "deferred")
        throw new Error("Settlement patch lost thread identity");
    return projected.value;
}
function settlementPrivacyContext(source, endTime, causalRunError) {
    if (source.payload.operation === "patch") {
        if (causalRunError)
            return { ...source.payload.privacyContext, status: "error" };
        if (endTime !== undefined && source.payload.privacyContext.status !== "error") {
            return { ...source.payload.privacyContext, status: "completed" };
        }
        return { ...source.payload.privacyContext };
    }
    if (causalRunError ||
        source.payload.run.error !== undefined ||
        source.payload.privacyContext?.status === "error") {
        return { status: "error" };
    }
    if (endTime !== undefined || source.payload.run.end_time !== undefined) {
        return { status: "completed" };
    }
    return { status: source.payload.privacyContext?.status ?? "running" };
}
function settlementPatch(endTime) {
    if (endTime === undefined)
        return { fields: [], values: {} };
    return { fields: ["end_time"], values: { end_time: endTime } };
}
export function addAttribution(metadata, attribution) {
    const layer = CODING_AGENT_INTEGRATION_POLICIES[metadata.integration].fullModePrecedence === "custom-wins"
        ? "base"
        : "runSpecific";
    const previous = metadata[layer] ?? {};
    return { ...metadata, [layer]: { ...previous, ...attribution } };
}
export function parseEvidence(value, attributionReady) {
    const source = requirePlainRecord(value, "Stored turn evidence");
    const childRunIds = requireStringArray(requireOwnDataField(source, "childRunIds"), "Child run IDs").map((runId) => requireNonBlankString(runId, "Child run ID"));
    const closureState = requireOwnDataField(source, "closureState");
    if (typeof closureState !== "string" ||
        !LIFECYCLE_TURN_CLOSURE_STATES.includes(closureState)) {
        throw new TypeError("Stored turn evidence has an invalid closure state");
    }
    const result = {
        childRunIds,
        closureState: closureState,
        attributionReady,
    };
    const rootRunId = ownDataField(source, "rootRunId");
    if (rootRunId.present && rootRunId.value !== undefined)
        result.rootRunId = requireNonBlankString(rootRunId.value, "Root run ID");
    return result;
}
export function closureRank(state) {
    if (state === "authoritative")
        return 2;
    if (state === "provisional")
        return 1;
    return 0;
}
//# sourceMappingURL=projection.js.map