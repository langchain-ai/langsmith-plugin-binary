import { buildCodingAgentMetadata } from "../../metadata/index.js";
import type { CodingAgentMetadataOptions } from "../../metadata/models.js";
import { requireNonBlankString } from "../../utils/validation/objects.js";
import type { ProjectedCapture, RecordedRun } from "./models.js";

function recordRun(events: ProjectedCapture[]): RecordedRun {
  const latest = events.at(-1)!;
  const run = latest.payload.run;
  return {
    run_id: latest.record.runId,
    ...(run.parent_run_id === undefined ? {} : { parent_run_id: run.parent_run_id }),
    trace_id: requireNonBlankString(run.trace_id, "Trace ID"),
    dotted_order: requireNonBlankString(run.dotted_order, "Dotted order"),
    name: requireNonBlankString(run.name, "Run name"),
    run_type: requireNonBlankString(run.run_type, "Run type"),
    tracing: latest.payload.privacyMode,
    open: latest.open,
    metadata: buildCodingAgentMetadata(mergeMetadataOptions(events)),
  };
}

function mergeMetadataOptions(captures: readonly ProjectedCapture[]): CodingAgentMetadataOptions {
  const first = captures[0];
  if (first === undefined) throw new Error("Run metadata is required for settlement");
  let merged = first.metadata;
  for (const { metadata } of captures.slice(1)) {
    const base = mergeMetadataObject(merged.base, metadata.base);
    const runSpecific = mergeMetadataObject(merged.runSpecific, metadata.runSpecific);
    const providerMetadata = mergeMetadataObject(
      merged.providerMetadata,
      metadata.providerMetadata,
    );
    const usageMetadata = mergeMetadataObject(merged.usageMetadata, metadata.usageMetadata);
    merged = {
      ...merged,
      ...metadata,
      ...(base === undefined ? {} : { base }),
      ...(runSpecific === undefined ? {} : { runSpecific }),
      ...(providerMetadata === undefined ? {} : { providerMetadata }),
      ...(usageMetadata === undefined ? {} : { usageMetadata }),
    };
  }
  return merged;
}

function mergeMetadataObject(
  previous: object | undefined,
  current: object | undefined,
): Record<string, unknown> | undefined {
  if (previous === undefined && current === undefined) return undefined;
  return { ...previous, ...current };
}

export { mergeMetadataOptions, recordRun };
