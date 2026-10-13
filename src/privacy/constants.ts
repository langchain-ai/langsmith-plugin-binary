export const MUTED_TRACE_CONTENT =
  "[LangSmith system notice: content omitted because tracing is muted.]";

export const METADATA_MODE_RUN_CONFIG_FIELDS = [
  "client",
  "id",
  "name",
  "run_type",
  "project_name",
  "start_time",
  "end_time",
  "parent_run",
  "parent_run_id",
  "trace_id",
  "dotted_order",
  "distributedParentId",
] as const;
