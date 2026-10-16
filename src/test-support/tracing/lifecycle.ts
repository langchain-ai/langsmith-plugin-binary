import { createServer } from "node:http";
import { CHILD_ID, ROOT_ID, SIBLING_ID, STRICT_DUPLICATE_UPDATE } from "../constants.js";
import { runUnits } from "./ingest.js";
import type { CodingAgentMetadataOptions } from "../../metadata/models.js";
import type { CaptureScope } from "../../storage/capture/models.js";
import { DOTTED_ORDER_STRIP_PATTERN } from "../../tracing/lifecycle/constants.js";
import { createLifecycleBridge } from "../../tracing/lifecycle/index.js";
import type {
  LifecycleBridge,
  LifecycleBridgeOptions,
  LifecycleTurnEvidence,
} from "../../tracing/lifecycle/models.js";
import type {
  LangSmithUploadWriterOptions,
  NormalizedRunSnapshot,
  PreparedRunPatchSubmission,
  PreparedRunPostSubmission,
  PreparedRunSubmission,
} from "../../tracing/upload/models.js";
import type {
  LocalEndpoint,
  LocalRequest,
  TestPatchValues,
  TestRun,
  TestSubmissionOptions,
} from "../models/lifecycle.js";

export { CHILD_ID, ROOT_ID, SIBLING_ID };
const ROOT_ORDER = `20261010T120000000000Z${ROOT_ID}`;
export const REPOSITORY = {
  ls_git_repo: "acme/project",
  ls_repo_provider: "github",
  ls_git_repo_url: "https://github.com/acme/project",
  ls_git_branch: "main",
  ls_git_commit_hash: "abc123",
};

const RUNS = {
  root: {
    id: ROOT_ID,
    name: "root run",
    run_type: "chain",
    start_time: "2026-10-10T12:00:00.000Z",
  },
  child: {
    id: CHILD_ID,
    name: "child run",
    run_type: "tool",
    start_time: "2026-10-10T12:00:00.001Z",
  },
  sibling: {
    id: SIBLING_ID,
    name: "sibling run",
    run_type: "tool",
    start_time: "2026-10-10T12:00:00.002Z",
  },
};

export async function localEndpoint(): Promise<LocalEndpoint> {
  const requests: LocalRequest[] = [];
  const failing = new Set<number>();
  const failingPaths = new Set<string>();
  const rejectedIds = new Set<string>();
  const updatedIds = new Set<string>();
  const state: LocalEndpoint["state"] = { mode: "ok" };
  let httpRequests = 0;
  let schemaRejections = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      httpRequests += 1;
      const index = requests.length;
      const payload = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
      const units = runUnits(request.method ?? "", request.url ?? "", payload);
      for (const unit of units)
        requests.push({
          method: unit.method,
          path: unit.path,
          wire: unit.wire,
          payload: unit.payload,
        });
      if (state.mode === "hang") return;
      if (state.mode === "strict") {
        const updates = units.filter((unit) => unit.method === "PATCH");
        if (updates.some((unit) => unit.payload["end_time"] === undefined)) {
          schemaRejections += 1;
          response.writeHead(422, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ detail: "batch schema error patch.0: end_time is required" }),
          );
          return;
        }
        const repeated = updates.filter((unit) => updatedIds.has(String(unit.payload["id"])));
        for (const unit of updates) updatedIds.add(String(unit.payload["id"]));
        const onlyRepeats = units.length > 0 && repeated.length === units.length;
        response.writeHead(onlyRepeats ? 409 : 200, { "content-type": "application/json" });
        response.end(onlyRepeats ? JSON.stringify({ detail: STRICT_DUPLICATE_UPDATE }) : "{}");
        return;
      }
      const refuse =
        state.mode === "down" ||
        failing.has(index) ||
        failingPaths.has(request.url ?? "") ||
        units.some((unit) => failingPaths.has(unit.path));
      const reject =
        state.mode === "reject" ||
        units.some((unit) => rejectedIds.has(String(unit.payload["id"])));
      response.writeHead(reject ? 400 : refuse ? 503 : 200, {
        "content-type": "application/json",
      });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local endpoint did not start");
  return {
    url: `http://127.0.0.1:${address.port}/api/v1`,
    requests,
    get httpRequests() {
      return httpRequests;
    },
    failing,
    failingPaths,
    rejectedIds,
    updatedIds,
    get schemaRejections() {
      return schemaRejections;
    },
    state,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export function writerFor(url: string, apiKey = "synthetic-lifecycle-key") {
  return {
    destinations: [{ apiKey, apiUrl: url, projectName: "lifecycle-test" }],
    redact: false,
  } satisfies LangSmithUploadWriterOptions;
}

function runMetadata(
  run: TestRun,
  options: TestSubmissionOptions = {},
): CodingAgentMetadataOptions {
  return {
    integration: "claude-code",
    threadId: "thread-1",
    agentType: "root",
    runType: run === "root" ? "root" : "tool",
    ...(options.base === undefined ? {} : { base: options.base }),
    ...options.metadata,
  };
}

function runContext(run: TestRun) {
  if (run === "root") return { ...RUNS.root, trace_id: ROOT_ID, dotted_order: ROOT_ORDER };
  const { id, start_time } = RUNS[run];
  const stamp = String(start_time).slice(0, 23).replaceAll(DOTTED_ORDER_STRIP_PATTERN, "");
  return {
    ...RUNS[run],
    parent_run_id: ROOT_ID,
    trace_id: ROOT_ID,
    dotted_order: `${ROOT_ORDER}.${stamp}000Z${id}`,
  };
}

export function runPost(
  run: TestRun,
  options: TestSubmissionOptions = {},
): PreparedRunPostSubmission {
  const metadata = runMetadata(run, options);
  return {
    operation: "post",
    integration: metadata.integration,
    privacyMode: options.privacyMode ?? "full",
    metadata,
    ...(options.privacyContext === undefined ? {} : { privacyContext: options.privacyContext }),
    ...(options.redactedFields === undefined ? {} : { redactedFields: options.redactedFields }),
    run: { ...runContext(run), inputs: {}, ...options.run } as NormalizedRunSnapshot,
  };
}

export function runPatch(
  run: TestRun,
  values: TestPatchValues,
  options: TestSubmissionOptions = {},
): PreparedRunPatchSubmission {
  const metadata = runMetadata(run, options);
  return {
    operation: "patch",
    integration: metadata.integration,
    privacyMode: options.privacyMode ?? "full",
    metadata,
    ...(options.redactedFields === undefined ? {} : { redactedFields: options.redactedFields }),
    run: runContext(run),
    privacyContext: options.privacyContext ?? { status: "completed" },
    patch: { fields: Object.keys(values) as (keyof TestPatchValues)[], values },
  };
}

export function turnEvidence(
  closureState: LifecycleTurnEvidence["closureState"] = "authoritative",
  childRunIds = [CHILD_ID],
  rootRunId: string | null = ROOT_ID,
): LifecycleTurnEvidence {
  return { ...(rootRunId === null ? {} : { rootRunId }), childRunIds, closureState };
}

export function captureScope(sessionId: string, turnId: string, eventId: string): CaptureScope {
  return { integration: "claude-code", sessionId, turnId, eventId };
}

export function testBridge(
  storageRoot: string,
  url: string,
  options: Partial<LifecycleBridgeOptions> = {},
): LifecycleBridge {
  return createLifecycleBridge({
    storageRoot,
    integration: "claude-code",
    sessionId: "session-1",
    writer: writerFor(url),
    ...options,
    policy: { retryBaseMs: 0, quickRetryMs: 0, ...options.policy },
  });
}

export function save(
  bridge: Pick<LifecycleBridge, "capture">,
  turnId: string,
  eventId: string,
  submission: PreparedRunSubmission,
  evidence = turnEvidence(),
  dependencies?: CaptureScope[],
) {
  return bridge.capture({
    turnId,
    eventId,
    submission,
    turnEvidence: evidence,
    ...(dependencies === undefined ? {} : { dependencies }),
  });
}
