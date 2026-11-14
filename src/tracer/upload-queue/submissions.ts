import type { CodingAgentPrivacyStatus } from "../../privacy/index.js";
import type {
  NormalizedRunPatchField,
  NormalizedRunPatchValues,
  PreparedRunPatchSubmission,
  PreparedRunPostSubmission,
} from "../../tracing/upload/models.js";
import type { RunPatch, RunPost } from "../models.js";
import { UPLOAD_QUEUE_PATCH_FIELDS } from "./upload-queue-constants.js";

export function mergeRun<T extends RunPost | RunPatch>(base: T, update: RunPatch | undefined): T {
  if (update === undefined) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [field, value] of Object.entries(update)) {
    if (value !== undefined) merged[field] = value;
  }
  return merged as T;
}

export function postSubmission(run: RunPost): PreparedRunPostSubmission {
  const privacyMode = run.tracingMode === "metadata" ? "metadata" : "full";
  return {
    operation: "post",
    integration: run.metadata.integration,
    privacyMode,
    metadata: run.metadata,
    ...(privacyMode === "metadata" ? { privacyContext: { status: privacyStatus(run) } } : {}),
    run: {
      id: run.id,
      name: run.name,
      run_type: run.run_type,
      start_time: run.start_time,
      trace_id: run.trace_id,
      dotted_order: run.dotted_order,
      inputs: (run.inputs ?? {}) as Record<string, unknown>,
      ...(run.parent_run_id === undefined ? {} : { parent_run_id: run.parent_run_id }),
      ...(run.end_time === undefined ? {} : { end_time: run.end_time }),
      ...(run.outputs === undefined ? {} : { outputs: run.outputs as Record<string, unknown> }),
      ...(run.error === undefined ? {} : { error: run.error }),
    },
  };
}

export function patchSubmission(patch: RunPatch): PreparedRunPatchSubmission {
  const fields: NormalizedRunPatchField[] = [];
  const values: Record<string, unknown> = {};
  for (const field of UPLOAD_QUEUE_PATCH_FIELDS) {
    if (patch[field] === undefined) continue;
    fields.push(field);
    values[field] = patch[field];
  }
  return {
    operation: "patch",
    integration: patch.metadata.integration,
    privacyMode: patch.tracingMode === "metadata" ? "metadata" : "full",
    metadata: patch.metadata,
    privacyContext: { status: privacyStatus(patch) },
    run: {
      id: patch.id,
      name: patch.name,
      run_type: patch.run_type,
      trace_id: patch.trace_id,
      dotted_order: patch.dotted_order,
      ...(patch.parent_run_id === undefined ? {} : { parent_run_id: patch.parent_run_id }),
      ...(patch.start_time === undefined ? {} : { start_time: patch.start_time }),
    },
    patch: { fields, values: values as NormalizedRunPatchValues },
  };
}

function privacyStatus(run: RunPost | RunPatch): CodingAgentPrivacyStatus {
  if (run.error !== undefined) return "error";
  return run.end_time === undefined ? "running" : "completed";
}
