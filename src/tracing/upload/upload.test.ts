import { CHILD_ID, RUN_ID } from "../../test-support/constants.js";
import type { LocalRequest } from "../../test-support/models/upload.js";
import { runUnits } from "../../test-support/tracing/ingest.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentMetadataOptions } from "../../metadata/index.js";
import { createLangSmithUploadWriter } from "./index.js";
import { createUploadClient } from "./client.js";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "./constants.js";
import { UploadError } from "./errors.js";
import { resolveUploadDestinationFingerprint } from "./identity.js";
import type {
  LangSmithUploadDestinationConfig,
  PreparedRunPatchSubmission,
  PreparedRunPostSubmission,
  LangSmithUploadWriter,
} from "./models.js";

const PRIMARY_KEY = "synthetic-primary-key";
const REPLICA_KEY = "synthetic-replica-key";
const FAILING_KEY = "synthetic-failing-key";
const CONFLICT_KEY = "synthetic-conflict-key";
const OTHER_CONFLICT_KEY = "synthetic-other-conflict-key";
const DUPLICATE_CREATE_KEY = "synthetic-duplicate-create-key";
const MISSING_KEY = "synthetic-missing-key";
const STATUS_KEYS = {
  503: "synthetic-503-key",
  429: "synthetic-429-key",
  409: "synthetic-409-key",
  408: "synthetic-408-key",
} as const;
const PRIVATE_MARKER = "synthetic-private-upload-marker";

let server: ReturnType<typeof createServer>;
let endpoint: string;
let requests: LocalRequest[];
let httpRequests = 0;
let storedRuns: Map<string, Record<string, unknown>>;

function destination(
  apiKey: string,
  projectName: string,
  workspaceId: string,
): LangSmithUploadDestinationConfig {
  return { apiKey, apiUrl: endpoint, projectName, workspaceId };
}

function submission(overrides: Partial<PreparedRunPostSubmission> = {}): PreparedRunPostSubmission {
  return {
    operation: "post",
    integration: "openai-codex",
    privacyMode: "metadata",
    run: {
      id: RUN_ID,
      name: "root run",
      run_type: "chain",
      start_time: "2026-10-09T20:00:00.000Z",
      end_time: "2026-10-09T20:00:01.000Z",
      inputs: { prompt: PRIVATE_MARKER },
      outputs: { answer: PRIVATE_MARKER },
      error: `${PRIVATE_MARKER}_error`,
      tags: ["source"],
      serialized: { type: "chain" },
    },
    metadata: metadata(),
    ...overrides,
  };
}

function patchSubmission(
  overrides: Partial<PreparedRunPatchSubmission> = {},
): PreparedRunPatchSubmission {
  return {
    operation: "patch",
    integration: "openai-codex",
    privacyMode: "metadata",
    run: {
      id: RUN_ID,
      name: "root run",
      run_type: "chain",
      start_time: "2026-10-09T20:00:00.000Z",
      trace_id: RUN_ID,
      dotted_order: `20261009T200000000Z${RUN_ID}`,
    },
    privacyContext: { status: "completed" },
    patch: { fields: [], values: {} },
    metadata: metadata(),
    ...overrides,
  };
}

function metadata(): CodingAgentMetadataOptions {
  return {
    integration: "openai-codex",
    threadId: "thread-1",
    turnId: "turn-1",
    agentType: "root",
    runType: "root",
    base: { private_metadata: PRIVATE_MARKER },
  };
}

function destinationByIndex(
  destinations: LangSmithUploadWriter["destinations"],
  index: number,
): string {
  const selectedDestination = destinations[index];
  if (!selectedDestination) throw new Error("Missing upload destination");
  return selectedDestination.id;
}

function recordRequest(request: IncomingMessage, response: ServerResponse): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    httpRequests += 1;
    const payload = body.length === 0 ? {} : (JSON.parse(body) as Record<string, unknown>);
    const apiKey = headerValue(request.headers["x-api-key"]) ?? "";
    for (const unit of runUnits(request.method ?? "", request.url ?? "", payload)) {
      requests.push({
        method: unit.method,
        path: unit.path,
        wire: unit.wire,
        apiKey,
        workspaceId: headerValue(request.headers["x-tenant-id"]),
        payload: unit.payload,
      });
      if (unit.method === "POST" && typeof unit.payload["id"] === "string") {
        storedRuns.set(apiKey + ":" + unit.payload["id"], unit.payload);
      } else if (unit.method === "PATCH") {
        const runId = decodeURIComponent(unit.path.split("/").at(-1) ?? "");
        const key = apiKey + ":" + runId;
        const previous = storedRuns.get(key);
        if (previous) storedRuns.set(key, { ...previous, ...unit.payload });
      }
    }
    if (request.headers["x-api-key"] === OTHER_CONFLICT_KEY) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Session quota exceeded." }));
      return;
    }
    if (request.headers["x-api-key"] === DUPLICATE_CREATE_KEY) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error:
            "Run create payload already received. Duplicate run create requests for the same run are not supported.",
        }),
      );
      return;
    }
    if (request.headers["x-api-key"] === CONFLICT_KEY) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Run update payload already received." }));
      return;
    }
    if (request.headers["x-api-key"] === MISSING_KEY) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "Run not found" }));
      return;
    }
    const status = Object.entries(STATUS_KEYS).find(
      ([, key]) => key === request.headers["x-api-key"],
    );
    if (status !== undefined) {
      response.writeHead(Number(status[0]), { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if (request.headers["x-api-key"] === FAILING_KEY) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "synthetic auth failure" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
}

function inputsOf(id: string): unknown {
  return requests.find(({ payload }) => payload["id"] === id)?.payload["inputs"];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

beforeEach(async () => {
  requests = [];
  httpRequests = 0;
  storedRuns = new Map();
  server = createServer(recordRequest);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local server did not start");
      endpoint = `http://127.0.0.1:${address.port}/api/v1`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("bound LangSmith upload writer", () => {
  it("posts independently to each configured destination", async () => {
    const writer = createLangSmithUploadWriter({
      redact: true,
      destinations: [
        destination(PRIMARY_KEY, "primary-project", "primary-workspace"),
        destination(REPLICA_KEY, "replica-project", "replica-workspace"),
      ],
    });
    const primaryId = destinationByIndex(writer.destinations, 0);
    const replicaId = destinationByIndex(writer.destinations, 1);

    await expect(writer.send(submission(), primaryId)).resolves.toMatchObject({
      destinationId: primaryId,
      runId: RUN_ID,
      operation: "posted",
    });
    await expect(writer.send(submission(), replicaId)).resolves.toMatchObject({
      destinationId: replicaId,
      runId: RUN_ID,
      operation: "posted",
    });

    expect(
      requests.map(({ method, apiKey, workspaceId }) => [method, apiKey, workspaceId]),
    ).toEqual([
      ["POST", PRIMARY_KEY, "primary-workspace"],
      ["POST", REPLICA_KEY, "replica-workspace"],
    ]);
    expect(requests.map(({ path }) => path)).toEqual(["/api/v1/runs", "/api/v1/runs"]);
    expect(requests[0]?.payload).toMatchObject({ session_name: "primary-project", id: RUN_ID });
    expect(requests[1]?.payload).toMatchObject({ session_name: "replica-project", id: RUN_ID });
  });
  it("patches each configured destination independently", async () => {
    const writer = createLangSmithUploadWriter({
      redact: true,
      destinations: [
        destination(PRIMARY_KEY, "primary-project", "primary-workspace"),
        destination(REPLICA_KEY, "replica-project", "replica-workspace"),
      ],
    });
    const primaryId = destinationByIndex(writer.destinations, 0);
    const replicaId = destinationByIndex(writer.destinations, 1);

    await expect(writer.send(patchSubmission(), primaryId)).resolves.toMatchObject({
      destinationId: primaryId,
      runId: RUN_ID,
      operation: "patched",
    });
    await expect(writer.send(patchSubmission(), replicaId)).resolves.toMatchObject({
      destinationId: replicaId,
      runId: RUN_ID,
      operation: "patched",
    });

    expect(
      requests.map(({ method, apiKey, workspaceId }) => [method, apiKey, workspaceId]),
    ).toEqual([
      ["PATCH", PRIMARY_KEY, "primary-workspace"],
      ["PATCH", REPLICA_KEY, "replica-workspace"],
    ]);
    expect(requests.map(({ path }) => path)).toEqual([
      `/api/v1/runs/${RUN_ID}`,
      `/api/v1/runs/${RUN_ID}`,
    ]);
    expect(requests[0]?.payload).toMatchObject({ session_name: "primary-project" });
    expect(requests[1]?.payload).toMatchObject({ session_name: "replica-project" });
  });

  it("updates run metadata without resending stored identity or content", async () => {
    const writer = createLangSmithUploadWriter({
      redact: false,
      destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
    });
    const destinationId = destinationByIndex(writer.destinations, 0);
    const initial = submission({
      privacyMode: "full",
      run: {
        ...submission().run,
        inputs: { prompt: "original prompt" },
        outputs: { answer: "original answer" },
        end_time: "2026-10-09T20:00:01.000Z",
        trace_id: "original-trace",
        dotted_order: "original-order",
      },
    });
    await writer.send(initial, destinationId);

    const patch = patchSubmission({
      privacyMode: "full",
      run: {
        id: RUN_ID,
        name: "root run",
        run_type: "chain",
        start_time: "2026-10-09T20:00:00.000Z",
        trace_id: "original-trace",
        dotted_order: "original-order",
      },
      metadata: { ...metadata(), turnNumber: 2 },
    });
    await writer.send(patch, destinationId);

    const request = requests[1];
    expect(request?.method).toBe("PATCH");
    expect(request?.payload).toMatchObject({
      id: RUN_ID,
      trace_id: "original-trace",
      dotted_order: "original-order",
      session_name: "primary-project",
      extra: { metadata: { thread_id: "thread-1", turn_number: 2 } },
    });
    for (const field of ["inputs", "outputs", "start_time", "end_time", "parent_run_id"]) {
      expect(request?.payload).not.toHaveProperty(field);
    }
    expect(storedRuns.get(PRIMARY_KEY + ":" + RUN_ID)).toMatchObject({
      inputs: { prompt: "original prompt" },
      outputs: { answer: "original answer" },
      end_time: "2026-10-09T20:00:01.000Z",
      extra: { metadata: { turn_number: 2 } },
    });
  });

  it("sends a mutable field only when the patch mask selects it", async () => {
    const writer = createLangSmithUploadWriter({
      redact: false,
      destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
    });
    const destinationId = destinationByIndex(writer.destinations, 0);
    const patch = patchSubmission({
      privacyMode: "full",
      patch: {
        fields: ["inputs"],
        values: {
          inputs: { prompt: "updated prompt" },
          outputs: { answer: "unselected answer" },
        },
      },
    });

    await writer.send(patch, destinationId);

    expect(requests[0]?.payload).toMatchObject({
      inputs: { prompt: "updated prompt" },
      session_name: "primary-project",
    });
    for (const field of [
      "name",
      "run_type",
      "outputs",
      "start_time",
      "end_time",
      "parent_run_id",
    ]) {
      expect(requests[0]?.payload).not.toHaveProperty(field);
    }
  });

  it("mutes selected content fields in metadata mode before sending the patch", async () => {
    const writer = createLangSmithUploadWriter({
      redact: false,
      destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
    });
    const patch = patchSubmission({
      privacyMode: "metadata",
      patch: {
        fields: ["inputs", "outputs"],
        values: {
          inputs: { prompt: PRIVATE_MARKER },
          outputs: { answer: PRIVATE_MARKER },
        },
      },
    });

    await writer.send(patch, destinationByIndex(writer.destinations, 0));

    expect(requests[0]?.payload).toMatchObject({
      inputs: { messages: [{ role: "user" }] },
      outputs: { messages: [{ role: "assistant" }] },
    });
    expect(JSON.stringify(requests[0]?.payload)).not.toContain(PRIVATE_MARKER);
  });

  it.each(["completed", "error"] as const)(
    "uses %s patch privacy status without sending source fields",
    async (status) => {
      const writer = createLangSmithUploadWriter({
        redact: false,
        destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
      });
      const destinationId = destinationByIndex(writer.destinations, 0);
      const patch = patchSubmission({
        privacyMode: "metadata",
        privacyContext: { status },
      });

      await writer.send(patch, destinationId);

      expect(requests[0]?.payload).toMatchObject({
        extra: { metadata: { status, ls_tracing_mode: "metadata" } },
        session_name: "primary-project",
      });
      expect(requests[0]?.payload).not.toHaveProperty("end_time");
      expect(requests[0]?.payload).not.toHaveProperty("error");
    },
  );

  it("rejects a failed replica while keeping the primary outcome verifiable", async () => {
    const writer = createLangSmithUploadWriter({
      redact: true,
      destinations: [
        destination(PRIMARY_KEY, "primary-project", "primary-workspace"),
        destination(FAILING_KEY, "replica-project", "replica-workspace"),
      ],
    });
    const primaryId = destinationByIndex(writer.destinations, 0);
    const replicaId = destinationByIndex(writer.destinations, 1);

    await expect(writer.send(submission(), primaryId)).resolves.toMatchObject({
      operation: "posted",
    });
    await expect(writer.send(submission(), replicaId)).rejects.toThrow("LangSmith upload failed");
    expect(requests.some(({ apiKey }) => apiKey === PRIMARY_KEY)).toBe(true);
    expect(requests.some(({ apiKey }) => apiKey === FAILING_KEY)).toBe(true);
  });

  it("counts a conflict on a post or a patch as already delivered", async () => {
    const writer = createLangSmithUploadWriter({
      redact: true,
      destinations: [destination(CONFLICT_KEY, "primary-project", "primary-workspace")],
    });
    const destinationId = destinationByIndex(writer.destinations, 0);

    await expect(writer.send(patchSubmission(), destinationId)).resolves.toEqual({
      destinationId,
      runId: RUN_ID,
      operation: "patched",
    });
    await expect(writer.send(submission(), destinationId)).resolves.toEqual({
      destinationId,
      runId: RUN_ID,
      operation: "posted",
    });
    expect(requests.map(({ method }) => method)).toEqual(["PATCH", "POST"]);
    const missing = createLangSmithUploadWriter({
      redact: true,
      destinations: [destination(MISSING_KEY, "primary-project", "primary-workspace")],
    });
    await expect(
      missing.send(patchSubmission(), destinationByIndex(missing.destinations, 0)),
    ).rejects.toThrow("LangSmith upload failed");
  });

  it("keeps metadata-mode wire content muted and uses the stable run ID on replay", async () => {
    const writer = createLangSmithUploadWriter({
      redact: true,
      destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
    });
    const destinationId = destinationByIndex(writer.destinations, 0);
    const run = submission();
    await writer.send(run, destinationId);
    await writer.send(run, destinationId);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.payload).toMatchObject({
        id: RUN_ID,
        inputs: { messages: [{ role: "user" }] },
        outputs: { messages: [{ role: "assistant" }] },
      });
      const inputs = request.payload["inputs"] as Record<string, unknown>;
      const outputs = request.payload["outputs"] as Record<string, unknown>;
      expect(JSON.stringify({ inputs, outputs })).not.toContain(PRIVATE_MARKER);
      const extra = request.payload["extra"] as Record<string, unknown>;
      const runMetadata = extra["metadata"] as Record<string, unknown>;
      expect(runMetadata).toMatchObject({
        thread_id: "thread-1",
        ls_tracing_mode: "metadata",
      });
      expect(runMetadata).not.toHaveProperty("private_metadata");
      expect(JSON.stringify(request.payload)).not.toContain(PRIVATE_MARKER);
    }
    expect(requests.map(({ payload }) => payload["id"])).toEqual([RUN_ID, RUN_ID]);
  });

  it("tells apart failures worth retrying from ones the service rejects for good", async () => {
    const cases = [
      [STATUS_KEYS[503], true],
      [STATUS_KEYS[429], true],
      [STATUS_KEYS[409], true],
      [STATUS_KEYS[408], true],
      [FAILING_KEY, false],
      [MISSING_KEY, false],
    ] as const;
    for (const [key, retryable] of cases) {
      const writer = createLangSmithUploadWriter({
        redact: true,
        destinations: [destination(key, "primary-project", "primary-workspace")],
      });
      const failure = await writer
        .send(submission(), destinationByIndex(writer.destinations, 0))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UploadError);
      expect((failure as UploadError).retryable).toBe(retryable);
      expect((failure as UploadError).status).toEqual(expect.any(Number));
    }
    const unreachable = createLangSmithUploadWriter({
      redact: true,
      destinations: [
        { apiKey: PRIMARY_KEY, apiUrl: "http://127.0.0.1:1/api/v1", projectName: "p" },
      ],
    });
    const failure = await unreachable
      .send(submission(), destinationByIndex(unreachable.destinations, 0))
      .catch((error: unknown) => error);
    expect((failure as UploadError).retryable).toBe(true);
  });

  it("sends queued runs of one trace to a locked project, not the projects they were saved with", async () => {
    const writer = createLangSmithUploadWriter({
      redact: true,
      projectLocked: true,
      destinations: [destination(PRIMARY_KEY, "locked-project", "primary-workspace")],
    });
    const items = [
      { submission: submission(), route: { projectName: "old-project" } },
      {
        submission: submission({
          run: { ...submission().run, id: CHILD_ID, parent_run_id: RUN_ID },
        }),
        route: { projectName: "other-project" },
      },
    ];
    await writer.sendBatch(items, destinationByIndex(writer.destinations, 0));
    expect(requests.map(({ payload }) => payload["session_name"])).toEqual([
      "locked-project",
      "locked-project",
    ]);
  });

  it("sends the key and workspace the way the SDK reads them, without quotes or spaces", async () => {
    const writer = createLangSmithUploadWriter({
      redact: true,
      destinations: [destination(` "${PRIMARY_KEY}" `, "primary-project", "'primary-workspace'")],
    });
    await writer.send(submission(), destinationByIndex(writer.destinations, 0));
    expect(requests[0]).toMatchObject({ apiKey: PRIMARY_KEY, workspaceId: "primary-workspace" });
  });

  it("sends a failing upload once and leaves retrying to the delivery backoff", async () => {
    const writer = createLangSmithUploadWriter({
      redact: true,
      destinations: [destination(STATUS_KEYS[503], "primary-project", "primary-workspace")],
    });
    await expect(
      writer.send(submission(), destinationByIndex(writer.destinations, 0)),
    ).rejects.toThrow("LangSmith upload failed");
    expect(requests).toHaveLength(1);
  });

  describe("batch ingest, so token counts are not doubled", () => {
    const LLM_ID = CHILD_ID;
    const llmRun = () =>
      submission({
        privacyMode: "full",
        run: {
          id: LLM_ID,
          name: "llm run",
          run_type: "llm",
          start_time: "2026-10-09T20:00:00.000Z",
          end_time: "2026-10-09T20:00:01.000Z",
          trace_id: LLM_ID,
          dotted_order: `20261009T200000000123Z${LLM_ID}`,
          inputs: { prompt: "p" },
          outputs: { answer: "a" },
        },
        metadata: { ...metadata(), usageMetadata: { input_tokens: 27, output_tokens: 3 } },
      });

    it("sends a finished llm run in a batch and never as a single create", async () => {
      const writer = createLangSmithUploadWriter({
        redact: false,
        destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
      });
      await writer.send(llmRun(), destinationByIndex(writer.destinations, 0));
      expect(requests).toHaveLength(1);
      expect(requests[0]?.wire).toMatch(/\/runs\/batch$/);
      expect(requests[0]?.payload).toMatchObject({ id: LLM_ID, end_time: expect.anything() });
    });

    it("sends several creates and updates to a destination in one request", async () => {
      const writer = createLangSmithUploadWriter({
        redact: false,
        destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
      });
      const other = "33333333-3333-4333-8333-333333333333";
      const receipts = await writer.sendBatch(
        [
          { submission: llmRun() },
          { submission: submission() },
          { submission: patchSubmission({ run: { ...patchSubmission().run, id: other } }) },
        ],
        destinationByIndex(writer.destinations, 0),
      );
      expect(httpRequests).toBe(1);
      expect(receipts.map(({ runId, operation }) => [runId, operation])).toEqual([
        [LLM_ID, "posted"],
        [RUN_ID, "posted"],
        [other, "patched"],
      ]);
      expect(requests.map(({ method, payload }) => [method, payload["id"]])).toEqual([
        ["POST", LLM_ID],
        ["POST", RUN_ID],
        ["PATCH", other],
      ]);
    });

    it("rejects a whole batch when the service refuses it", async () => {
      const writer = createLangSmithUploadWriter({
        redact: false,
        destinations: [destination(FAILING_KEY, "primary-project", "primary-workspace")],
      });
      await expect(
        writer.sendBatch(
          [{ submission: llmRun() }, { submission: submission() }],
          destinationByIndex(writer.destinations, 0),
        ),
      ).rejects.toThrow("LangSmith upload failed");
      expect(httpRequests).toBe(1);
    });

    describe("runs that need different redaction", () => {
      const SECRET = "sk-ant-api03-" + "A".repeat(40);
      const withInputs = (id: string, extra: Partial<PreparedRunPostSubmission> = {}) =>
        submission({
          privacyMode: "full",
          run: { ...submission().run, id, inputs: { text: SECRET } },
          ...extra,
        });
      const redacted = (id: string) => withInputs(id, { redactedFields: ["inputs"] });
      const SECOND_ID = "33333333-3333-4333-8333-333333333333";

      it("never sends a run through a client that redacts differently", async () => {
        const writer = createLangSmithUploadWriter({
          redact: true,
          destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
        });
        await writer.sendBatch(
          [{ submission: redacted(CHILD_ID) }, { submission: withInputs(RUN_ID) }],
          destinationByIndex(writer.destinations, 0),
        );
        expect(inputsOf(RUN_ID)).toEqual({ text: "[SECRET_DETECTED]" });
        expect(inputsOf(CHILD_ID)).toEqual({ text: SECRET });
      });

      it("keeps the order of runs when their redaction differs", async () => {
        const writer = createLangSmithUploadWriter({
          redact: true,
          destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
        });
        await writer.sendBatch(
          [
            { submission: redacted(CHILD_ID) },
            { submission: withInputs(RUN_ID) },
            { submission: redacted(SECOND_ID) },
          ],
          destinationByIndex(writer.destinations, 0),
        );
        expect(httpRequests).toBe(3);
        expect(requests.map(({ payload }) => payload["id"])).toEqual([CHILD_ID, RUN_ID, SECOND_ID]);
      });
    });

    it("keeps a batch pending when the service answers 409 for another reason", async () => {
      const writer = createLangSmithUploadWriter({
        redact: false,
        destinations: [destination(OTHER_CONFLICT_KEY, "primary-project", "primary-workspace")],
      });
      await expect(
        writer.sendBatch([{ submission: llmRun() }], destinationByIndex(writer.destinations, 0)),
      ).rejects.toThrow("LangSmith upload failed");
    });

    it("counts the duplicate create answer of LangSmith as delivered", async () => {
      const writer = createLangSmithUploadWriter({
        redact: false,
        destinations: [destination(DUPLICATE_CREATE_KEY, "primary-project", "primary-workspace")],
      });
      await expect(
        writer.sendBatch([{ submission: llmRun() }], destinationByIndex(writer.destinations, 0)),
      ).resolves.toHaveLength(1);
    });

    it.each([
      [
        "a millisecond string as the plugin built it",
        "2026-10-09T20:00:00.000Z",
        "2026-10-09T20:00:00.000Z",
      ],
      [
        "a microsecond string as the plugin built it",
        "2026-10-09T20:00:00.000456Z",
        "2026-10-09T20:00:00.000456Z",
      ],
      [
        "an epoch number as an ISO string",
        Date.parse("2026-10-09T20:00:00.000Z"),
        "2026-10-09T20:00:00.000Z",
      ],
      [
        "nothing, taking microseconds from the dotted order",
        undefined,
        "2026-10-09T20:00:00.000123Z",
      ],
    ])("sends the start time from %s", async (_name, supplied, expected) => {
      const writer = createLangSmithUploadWriter({
        redact: false,
        destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
      });
      const run = llmRun();
      if (supplied === undefined) delete run.run.start_time;
      else run.run.start_time = supplied;
      await writer.send(run, destinationByIndex(writer.destinations, 0));
      expect(requests[0]?.payload["start_time"]).toBe(expected);
    });
  });

  it("serializes inline and gives each request a time limit", () => {
    const client = createUploadClient({ apiKey: PRIMARY_KEY, apiUrl: "http://127.0.0.1:9" });
    expect(Reflect.get(client, "manualFlushMode")).toBe(true);
    expect(Reflect.get(client, "timeout_ms")).toBe(UPLOAD_REQUEST_TIMEOUT_MS);
  });

  it("does not force a sample rate on the SDK client", () => {
    const client = createUploadClient({ apiKey: PRIMARY_KEY, apiUrl: "http://127.0.0.1:9" });
    expect(Reflect.get(client, "tracingSampleRate")).toBeUndefined();
  });

  it("applies configured secret rules and preserves content when redaction is disabled", async () => {
    const enabled = createLangSmithUploadWriter({
      destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
      redact: true,
      redactExtraRules: [{ pattern: PRIVATE_MARKER, replace: "[private removed]" }],
    });
    const disabled = createLangSmithUploadWriter({
      destinations: [destination(REPLICA_KEY, "replica-project", "replica-workspace")],
      redact: false,
    });
    const fullRun = submission({
      privacyMode: "full",
      run: {
        ...submission().run,
        tags: [PRIVATE_MARKER],
        serialized: { name: PRIVATE_MARKER },
        events: [{ name: "output", message: PRIVATE_MARKER }],
      },
    });
    await enabled.send(fullRun, enabled.destinations[0]!.id);
    await disabled.send(fullRun, disabled.destinations[0]!.id);

    const redacted = JSON.stringify(requests[0]?.payload);
    const unredacted = JSON.stringify(requests[1]?.payload);
    expect(requests[0]?.payload["tags"]).toEqual(["[private removed]"]);
    expect(requests[0]?.payload["serialized"]).toEqual({ name: "[private removed]" });
    expect(requests[0]?.payload["events"]).toEqual([
      { name: "output", message: "[private removed]" },
    ]);
    expect(redacted).not.toContain(PRIVATE_MARKER);
    expect(redacted).toContain("[private removed]");
    expect(requests[1]?.payload["tags"]).toEqual([PRIVATE_MARKER]);
    expect(requests[1]?.payload["serialized"]).toEqual({ name: PRIVATE_MARKER });
    expect(requests[1]?.payload["events"]).toEqual([{ name: "output", message: PRIVATE_MARKER }]);
    expect(unredacted).toContain(PRIVATE_MARKER);
    expect(unredacted).not.toContain("[private removed]");
  });

  it("rejects nested child payloads so each run is uploaded through its own privacy projection", async () => {
    const writer = createLangSmithUploadWriter({
      destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
      redact: true,
    });
    const unsafe = submission();
    Object.assign(unsafe.run, {
      child_runs: [{ id: "child", inputs: { prompt: PRIVATE_MARKER } }],
    });

    await expect(writer.send(unsafe, writer.destinations[0]!.id)).rejects.toThrow("single run");
    expect(requests).toHaveLength(0);
  });

  it("keeps destination IDs stable across order and fingerprints all bound credentials", () => {
    const primary = destination(PRIMARY_KEY, "primary-project", "primary-workspace");
    const replica = destination(REPLICA_KEY, "replica-project", "replica-workspace");
    const first = createLangSmithUploadWriter({ destinations: [primary, replica], redact: true });
    const reordered = createLangSmithUploadWriter({
      destinations: [replica, primary],
      redact: true,
    });
    const changedKey = createLangSmithUploadWriter({
      destinations: [
        destination("synthetic-new-key", "primary-project", "primary-workspace"),
        replica,
      ],
      redact: true,
    });
    const changedRedaction = createLangSmithUploadWriter({
      destinations: [primary, replica],
      redact: false,
    });
    const changedRedactionRules = createLangSmithUploadWriter({
      destinations: [primary, replica],
      redact: true,
      redactExtraRules: [{ pattern: "synthetic-private-upload-marker" }],
    });

    expect(first.accountFingerprint).toBe(reordered.accountFingerprint);
    expect(
      resolveUploadDestinationFingerprint({ destinations: [primary, replica], redact: true }),
    ).toBe(first.accountFingerprint);
    expect(
      resolveUploadDestinationFingerprint({ destinations: [replica, primary], redact: true }),
    ).toBe(reordered.accountFingerprint);
    expect(first.destinations.map(({ id }) => id).toSorted()).toEqual(
      reordered.destinations.map(({ id }) => id).toSorted(),
    );
    expect(first.accountFingerprint).not.toBe(changedKey.accountFingerprint);
    expect(first.accountFingerprint).not.toBe(changedRedaction.accountFingerprint);
    expect(first.accountFingerprint).not.toBe(changedRedactionRules.accountFingerprint);
    expect(
      resolveUploadDestinationFingerprint({ destinations: [primary, replica], redact: false }),
    ).toBe(changedRedaction.accountFingerprint);
    expect(
      resolveUploadDestinationFingerprint({
        destinations: [primary, replica],
        redact: true,
        redactExtraRules: [{ pattern: "synthetic-private-upload-marker" }],
      }),
    ).toBe(changedRedactionRules.accountFingerprint);
    expect(first.destinations.map(({ id }) => id).join(" ")).not.toContain(PRIMARY_KEY);
    expect(first.destinations.map(({ id }) => id).join(" ")).not.toContain(REPLICA_KEY);
  });
});

function samplingTraceIds(index: number) {
  const suffix = index.toString(16).padStart(12, "0");
  const root = `00000000-0000-4000-8000-${suffix}`;
  return {
    root,
    child: `00000000-0000-4000-9000-${suffix}`,
    order: `20261009T200000000000Z${root}`,
  };
}

function samplingTraceRuns(index: number): PreparedRunPostSubmission[] {
  const { root, child, order } = samplingTraceIds(index);
  const run = submission().run;
  return [
    submission({ run: { ...run, id: root, trace_id: root.toUpperCase(), dotted_order: order } }),
    submission({
      run: {
        ...run,
        id: child,
        name: "child run",
        parent_run_id: root,
        dotted_order: `${order.toUpperCase()}.20261009T200000500000Z${child}`,
      },
    }),
  ];
}

function samplingPatches(index: number): PreparedRunPatchSubmission[] {
  const { root, child } = samplingTraceIds(index);
  const { trace_id: _trace, dotted_order: _order, ...run } = patchSubmission().run;
  const patch = { fields: ["end_time" as const], values: { end_time: "2026-10-09T20:00:02.000Z" } };
  return [
    patchSubmission({ run: { ...run, id: root }, patch }),
    patchSubmission({ run: { ...run, id: child, parent_run_id: root, trace_id: root }, patch }),
  ];
}

function samplingWriter(): LangSmithUploadWriter {
  return createLangSmithUploadWriter({
    redact: true,
    destinations: [destination(PRIMARY_KEY, "primary-project", "primary-workspace")],
  });
}

function sentIds(method: string): Set<unknown> {
  return new Set(
    requests.filter((request) => request.method === method).map(({ payload }) => payload["id"]),
  );
}

async function sendSampledTrace() {
  const writer = samplingWriter();
  return writer.sendBatch(
    samplingTraceRuns(0).map((run) => ({ submission: run })),
    destinationByIndex(writer.destinations, 0),
  );
}

describe("trace sampling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps or drops each whole trace the same way in every process", async () => {
    vi.stubEnv("LANGSMITH_TRACING_SAMPLING_RATE", "0.5");
    const indexes = Array.from({ length: 20 }, (_, index) => index);
    const posts = samplingWriter();
    const receipts = await posts.sendBatch(
      indexes.flatMap((index) => samplingTraceRuns(index).map((run) => ({ submission: run }))),
      destinationByIndex(posts.destinations, 0),
    );
    const patches = samplingWriter();
    await patches.sendBatch(
      indexes.flatMap((index) => samplingPatches(index).map((run) => ({ submission: run }))),
      destinationByIndex(patches.destinations, 0),
    );
    const posted = sentIds("POST");
    const patched = sentIds("PATCH");
    const kept = indexes.filter((index) => posted.has(samplingTraceIds(index).root));
    for (const index of indexes) {
      const { root, child } = samplingTraceIds(index);
      const rootKept = posted.has(root);
      expect([posted.has(child), patched.has(root), patched.has(child)]).toEqual([
        rootKept,
        rootKept,
        rootKept,
      ]);
    }
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(indexes.length);
    expect(receipts).toHaveLength(40);
  });

  it("sends everything without a valid rate and nothing at a rate of zero", async () => {
    await sendSampledTrace();
    vi.stubEnv("LANGSMITH_TRACING_SAMPLING_RATE", " ");
    await sendSampledTrace();
    vi.stubEnv("LANGSMITH_TRACING_SAMPLING_RATE", "not-a-number");
    vi.stubEnv("LANGCHAIN_TRACING_SAMPLING_RATE", "0");
    await sendSampledTrace();
    expect(requests).toHaveLength(6);
    vi.stubEnv("LANGSMITH_TRACING_SAMPLING_RATE", "");
    await expect(sendSampledTrace()).resolves.toHaveLength(2);
    expect(requests).toHaveLength(6);
  });
});
