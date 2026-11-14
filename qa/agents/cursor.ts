import type { TracingSettings } from "../models.ts";

export function cursorTracingEnvironment(options: TracingSettings): Record<string, string> {
  return {
    TRACE_TO_LANGSMITH: "true",
    CURSOR_PLUGIN_ROOT: options.pluginDir,
    LANGSMITH_CURSOR_ENDPOINT: options.endpoints.tracing,
    LANGSMITH_CURSOR_API_KEY: options.tracingApiKey,
    LANGSMITH_CURSOR_PROJECT: options.project,
  };
}
