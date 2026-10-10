import { buildCodingAgentMetadata } from "../../metadata/index.js";
import { createCodingAgentRunTree } from "../../privacy/index.js";
import { resolveUploadDestinations } from "./destinations.js";
import { UPLOAD_PATCH_FIELDS } from "./constants.js";
import { redactSdkOmittedFields } from "./redaction.js";
export function createLangSmithUploadWriter(options) {
    const resolved = resolveUploadDestinations(options);
    const destinations = resolved.destinations.map(({ id }) => Object.freeze({ id }));
    const byId = new Map(resolved.destinations.map((destination) => [destination.id, destination]));
    return Object.freeze({
        accountFingerprint: resolved.accountFingerprint,
        destinations: Object.freeze(destinations),
        async send(submission, destinationId) {
            const destination = byId.get(destinationId);
            if (!destination)
                throw new TypeError("Unknown upload destination");
            validateSubmission(submission);
            const payload = submission.operation === "post"
                ? preparePostRunPayload(submission, destination)
                : preparePatchRunPayload(submission, destination);
            redactSdkOmittedFields(payload, destination.anonymizer);
            const clientOptions = {
                apiKey: destination.apiKey,
                apiUrl: destination.apiUrl,
                ...(destination.workspaceId === undefined ? {} : { workspaceId: destination.workspaceId }),
            };
            try {
                if (submission.operation === "post") {
                    await destination.client.createRun({ ...payload, project_name: destination.projectName }, clientOptions);
                    return { destinationId, runId: submission.run.id, operation: "posted" };
                }
                await destination.client.updateRun(submission.run.id, payload, clientOptions);
                return { destinationId, runId: submission.run.id, operation: "patched" };
            }
            catch {
                throw new Error("LangSmith upload failed");
            }
        },
    });
}
function runConfig(context, submission, destination) {
    const metadata = buildCodingAgentMetadata(submission.metadata);
    return {
        id: context.id,
        name: context.name,
        run_type: context.run_type,
        project_name: destination.projectName,
        inputs: {},
        extra: { metadata },
        client: destination.client,
        ...(context.start_time === undefined ? {} : { start_time: context.start_time }),
        ...(context.parent_run_id === undefined ? {} : { parent_run_id: context.parent_run_id }),
        ...(context.trace_id === undefined ? {} : { trace_id: context.trace_id }),
        ...(context.dotted_order === undefined ? {} : { dotted_order: context.dotted_order }),
    };
}
function preparePostRunPayload(submission, destination) {
    const source = submission.run;
    const config = runConfig(source, submission, destination);
    config.inputs = source.inputs;
    if (source.end_time !== undefined)
        config.end_time = source.end_time;
    if (source.outputs !== undefined)
        config.outputs = source.outputs;
    if (source.tags !== undefined)
        config.tags = source.tags;
    if (source.error !== undefined)
        config.error = source.error;
    if (source.serialized !== undefined)
        config.serialized = source.serialized;
    if (source.reference_example_id !== undefined) {
        config.reference_example_id = source.reference_example_id;
    }
    const run = createCodingAgentRunTree(config, submission.integration, submission.privacyMode);
    if (source.events !== undefined)
        run.events = source.events;
    return JSON.parse(JSON.stringify(run.toJSON()));
}
function preparePatchRunPayload(submission, destination) {
    const config = runConfig(submission.run, submission, destination);
    for (const field of submission.patch.fields) {
        if (field === "inputs")
            config.inputs = submission.patch.values.inputs;
        else if (field === "outputs")
            config.outputs = submission.patch.values.outputs;
        else if (field === "end_time")
            config.end_time = submission.patch.values.end_time;
        else if (field === "error")
            config.error = submission.patch.values.error;
        else if (field === "tags")
            config.tags = submission.patch.values.tags;
        else if (field === "serialized")
            config.serialized = submission.patch.values.serialized;
        else if (field === "reference_example_id") {
            config.reference_example_id = submission.patch.values.reference_example_id;
        }
    }
    const run = createCodingAgentRunTree(config, submission.integration, submission.privacyMode, submission.privacyContext);
    if (submission.patch.fields.includes("events")) {
        run.events = submission.patch.values.events;
    }
    const snapshot = JSON.parse(JSON.stringify(run.toJSON()));
    const update = {
        extra: snapshot["extra"],
        session_name: destination.projectName,
    };
    for (const field of submission.patch.fields) {
        const value = snapshot[field];
        if (value === undefined)
            continue;
        if (field === "inputs")
            update.inputs = value;
        else if (field === "outputs")
            update.outputs = value;
        else if (field === "end_time")
            update.end_time = value;
        else if (field === "error")
            update.error = value;
        else if (field === "tags")
            update.tags = value;
        else if (field === "serialized")
            update.serialized = value;
        else if (field === "events")
            update.events = value;
        else if (field === "reference_example_id") {
            update.reference_example_id = value;
        }
    }
    return update;
}
function validateSubmission(submission) {
    if (submission === null || typeof submission !== "object") {
        throw new TypeError("A prepared run submission is required");
    }
    if (submission.operation !== "post" && submission.operation !== "patch") {
        throw new TypeError("Invalid upload operation");
    }
    if (submission.metadata === null || typeof submission.metadata !== "object") {
        throw new TypeError("Run metadata is required");
    }
    if (submission.integration !== submission.metadata.integration) {
        throw new TypeError("Run metadata integration does not match the submission");
    }
    if (submission.run === null || typeof submission.run !== "object") {
        throw new TypeError("Run data is required");
    }
    if (Object.hasOwn(submission.run, "child_runs")) {
        throw new TypeError("Each upload submission must contain a single run");
    }
    if (typeof submission.run.id !== "string" || submission.run.id.trim().length === 0) {
        throw new TypeError("A stable run ID is required");
    }
    if (submission.privacyMode !== "full" && submission.privacyMode !== "metadata") {
        throw new TypeError("Invalid privacy mode");
    }
    if (submission.operation === "patch")
        validatePatch(submission);
}
function validatePatch(submission) {
    if (submission.patch === null ||
        typeof submission.patch !== "object" ||
        !Array.isArray(submission.patch.fields) ||
        submission.patch.values === null ||
        typeof submission.patch.values !== "object") {
        throw new TypeError("A patch field set and values are required");
    }
    if (typeof submission.run.name !== "string" || typeof submission.run.run_type !== "string") {
        throw new TypeError("Patch run context must preserve its name and type");
    }
    const selected = new Set();
    for (const candidate of submission.patch.fields) {
        if (typeof candidate !== "string" ||
            !UPLOAD_PATCH_FIELDS.has(candidate)) {
            throw new TypeError("Invalid patch field");
        }
        const field = candidate;
        if (selected.has(field))
            throw new TypeError("Patch fields must be unique");
        if (!Object.hasOwn(submission.patch.values, field) ||
            submission.patch.values[field] === undefined) {
            throw new TypeError("Every selected patch field must have a value");
        }
        selected.add(field);
    }
}
//# sourceMappingURL=upload.js.map