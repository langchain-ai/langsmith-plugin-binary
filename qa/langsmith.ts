import { setTimeout as sleep } from "node:timers/promises";
import { DEV_ENDPOINT, RUN_QUERY_LIMIT, UPLOAD_POLL_MS, UPLOAD_TIMEOUT_MS } from "./constants.ts";
import type { TracedRun } from "./models.ts";

async function request<T>(apiKey: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${DEV_ENDPOINT}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`LangSmith ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

async function listRuns(apiKey: string, project: string): Promise<TracedRun[]> {
  const sessions = await request<{ id: string }[]>(
    apiKey,
    `/api/v1/sessions?name=${encodeURIComponent(project)}`,
  );
  const session = sessions[0];
  if (session === undefined) return [];
  const result = await request<{ runs: TracedRun[] }>(apiKey, "/api/v1/runs/query", {
    session: [session.id],
    limit: RUN_QUERY_LIMIT,
    select: [
      "id",
      "name",
      "run_type",
      "trace_id",
      "parent_run_id",
      "start_time",
      "end_time",
      "inputs",
      "outputs",
    ],
  });
  return result.runs;
}

export async function waitForRuns(
  apiKey: string,
  project: string,
  expectedRoots: number,
): Promise<TracedRun[]> {
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  let runs: TracedRun[] = [];
  while (Date.now() < deadline) {
    runs = await listRuns(apiKey, project).catch(() => runs);
    const roots = runs.filter((run) => run.parent_run_id === null);
    await sleep(UPLOAD_POLL_MS);
    if (roots.length >= expectedRoots && roots.every((run) => run.end_time !== null))
      return listRuns(apiKey, project);
  }
  return runs;
}
