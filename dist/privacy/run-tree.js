import { RunTree } from "langsmith";
import { metadataForMode, projectCodingAgentMetadata, } from "../metadata/index.js";
import { METADATA_MODE_RUN_CONFIG_FIELDS, MUTED_TRACE_CONTENT } from "./constants.js";
function mutedContent(role) {
    return { messages: [{ role, content: MUTED_TRACE_CONTENT }] };
}
function statusOfRun(run) {
    if (run.error != null)
        return "error";
    if (run.extra?.metadata?.status === "error")
        return "error";
    return run.end_time == null ? "running" : "completed";
}
function projectReplica(replica) {
    if (!replica || typeof replica !== "object")
        return replica;
    if (Array.isArray(replica))
        return { projectName: replica[0] };
    const { updates: _updates, ...safe } = replica;
    return safe;
}
function extraForMode(metadata, integration, status) {
    return {
        metadata,
        toJSON() {
            const currentStatus = this.metadata?.status;
            const safeStatus = currentStatus === "running" || currentStatus === "completed" || currentStatus === "error"
                ? currentStatus
                : status;
            return {
                metadata: projectCodingAgentMetadata(this.metadata, integration, safeStatus),
            };
        },
    };
}
function configForMetadataMode(config, integration) {
    const source = config;
    const status = source.error != null ? "error" : source.end_time != null ? "completed" : "running";
    const originalExtra = source.extra;
    const safe = {};
    for (const key of METADATA_MODE_RUN_CONFIG_FIELDS) {
        if (key in source && source[key] !== undefined)
            safe[key] = source[key];
    }
    if (Array.isArray(source.replicas))
        safe.replicas = source.replicas.map(projectReplica);
    safe.inputs = mutedContent("user");
    safe.outputs = mutedContent("assistant");
    safe.extra = extraForMode(metadataForMode(originalExtra?.metadata, integration, "metadata", status) ?? {}, integration, status);
    return safe;
}
function sanitizeRunTree(run, integration) {
    const status = statusOfRun(run);
    const metadata = projectCodingAgentMetadata(run.extra?.metadata, integration, status);
    run.inputs = mutedContent("user");
    run.outputs = mutedContent("assistant");
    delete run.error;
    run.serialized = {};
    delete run.tags;
    delete run.reference_example_id;
    delete run.attachments;
    delete run.events;
    if (run.replicas)
        run.replicas = run.replicas.map(projectReplica);
    for (const child of run.child_runs ?? [])
        sanitizeRunTree(child, integration);
    run.extra = extraForMode(metadata, integration, status);
}
function protectRunTree(run, integration) {
    sanitizeRunTree(run, integration);
    const createChild = run.createChild.bind(run);
    run.createChild = (config) => protectRunTree(createChild(configForMetadataMode(config, integration)), integration);
    const postRun = run.postRun.bind(run);
    run.postRun = async (excludeChildRuns = true) => {
        sanitizeRunTree(run, integration);
        if (!excludeChildRuns) {
            const childRuns = [...run.child_runs];
            await postRun(true);
            for (const childRun of childRuns)
                await childRun.postRun(false);
            return;
        }
        return postRun(excludeChildRuns);
    };
    const patchRun = run.patchRun.bind(run);
    run.patchRun = (options) => {
        sanitizeRunTree(run, integration);
        return patchRun({ excludeInputs: false, ...options });
    };
    const end = run.end.bind(run);
    run.end = (outputs, error, endTime, metadata) => {
        const status = error != null ? "error" : endTime != null ? "completed" : statusOfRun(run);
        const safeMetadata = metadataForMode(metadata, integration, "metadata", status) ?? { status };
        return end(mutedContent("assistant"), undefined, endTime, safeMetadata);
    };
    const toJSON = run.toJSON.bind(run);
    run.toJSON = () => {
        sanitizeRunTree(run, integration);
        return toJSON();
    };
    return run;
}
function preserveFullModePatchInputs(run) {
    const createChild = run.createChild.bind(run);
    run.createChild = (config) => preserveFullModePatchInputs(createChild(config));
    const patchRun = run.patchRun.bind(run);
    run.patchRun = (options) => patchRun({ excludeInputs: false, ...options });
    return run;
}
export function createCodingAgentRunTree(config, integration, mode = "full") {
    const run = new RunTree(mode === "metadata" ? configForMetadataMode(config, integration) : config);
    return mode === "metadata" ? protectRunTree(run, integration) : preserveFullModePatchInputs(run);
}
//# sourceMappingURL=run-tree.js.map