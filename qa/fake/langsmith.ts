import type { RunBatch, RunPayload, TracedRun } from "../models.ts";

function isoTime(time: unknown): string | null {
  if (time === undefined || time === null) return null;
  return new Date(time as string | number).toISOString();
}

export class RunCapture {
  private readonly stored = new Map<string, RunPayload>();

  receiveBatch(body: RunBatch): void {
    for (const run of [...(body.post ?? []), ...(body.patch ?? [])]) {
      this.stored.set(run.id, { ...this.stored.get(run.id), ...run });
    }
  }

  runs(): TracedRun[] {
    return [...this.stored.values()].map((run) => ({
      id: run.id,
      name: String(run.name ?? ""),
      run_type: String(run.run_type ?? ""),
      trace_id: String(run.trace_id ?? run.id),
      parent_run_id: (run.parent_run_id as string | undefined) ?? null,
      start_time: isoTime(run.start_time) ?? "",
      end_time: isoTime(run.end_time),
      inputs: run.inputs,
      outputs: run.outputs,
    }));
  }
}
