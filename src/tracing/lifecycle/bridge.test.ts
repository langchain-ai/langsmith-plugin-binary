import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import { eventPath } from "../../storage/capture/paths.js";
import type { CaptureDependency, CaptureScope } from "../../storage/capture/models.js";
import { canonicalJsonValue } from "../../utils/validation/objects.js";
import { MUTED_TRACE_CONTENT } from "../../privacy/index.js";
import type {
  LangSmithUploadDestinationConfig,
  PreparedRunPatchSubmission,
  PreparedRunPostSubmission,
} from "../upload/models.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import type { LocalRequest } from "../../test-support/models/lifecycle.js";
import { createLifecycleBridge } from "./index.js";
import { createReconstructionWorker } from "../reconstruction/index.js";
import type { ReconstructionJob } from "../reconstruction/models.js";
import type {
  LifecycleCaptureInput,
  LifecycleCaptureResult,
  LifecycleSnapshotCaptureInput,
  LifecycleTurnEvidence,
} from "./models.js";

const PRIVATE_MARKER = "lifecycle-private-content-marker";
const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const SIBLING_ID = "33333333-3333-4333-8333-333333333333";
const PARENT_DOTTED_ORDER = `20261010T120000000000Z${PARENT_ID}`;
const CHILD_DOTTED_ORDER = `${PARENT_DOTTED_ORDER}.20261010T120000001000Z${CHILD_ID}`;
const SIBLING_DOTTED_ORDER = `${PARENT_DOTTED_ORDER}.20261010T120000002000Z${SIBLING_ID}`;

let server: ReturnType<typeof createServer>;
let endpoint: string;
let requests: LocalRequest[];
let failChildPatches = false;
let failRequestIndexes: Set<number>;

function requestBody(request: IncomingMessage, response: ServerResponse): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    const index = requests.length;
    const payload = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      payload,
    });
    response.writeHead(
      (failChildPatches &&
        request.method === "PATCH" &&
        request.url === `/api/v1/runs/${CHILD_ID}`) ||
        failRequestIndexes.has(index)
        ? 400
        : 200,
      { "content-type": "application/json" },
    );
    response.end("{}");
  });
}

function destination(): LangSmithUploadDestinationConfig {
  return { apiKey: "synthetic-lifecycle-key", apiUrl: endpoint, projectName: "lifecycle-test" };
}

function evidence(overrides: Partial<LifecycleTurnEvidence> = {}): LifecycleTurnEvidence {
  return { childRunIds: [], closureState: "open", ...overrides };
}

function post(
  id: string,
  runMetadata: PreparedRunPostSubmission["metadata"],
  overrides: Partial<PreparedRunPostSubmission["run"]> = {},
  privacyMode: "full" | "metadata" = "full",
): PreparedRunPostSubmission {
  return {
    operation: "post",
    integration: runMetadata.integration,
    privacyMode,
    metadata: runMetadata,
    run: {
      id,
      name: "test run",
      run_type: "chain",
      inputs: { prompt: "safe prompt" },
      ...overrides,
    },
  };
}

function metadata(
  integration: PreparedRunPostSubmission["integration"],
  runType: PreparedRunPostSubmission["metadata"]["runType"],
): PreparedRunPostSubmission["metadata"] {
  return { integration, threadId: "thread-1", agentType: "root", runType };
}

function repositoryMetadata(branch: string): PreparedRunPostSubmission["metadata"] {
  return {
    ...metadata("claude-code", "root"),
    base: { repository_name: "acme/project", git_branch: branch },
  };
}

function snapshotInput(
  eventId: string,
  runOverrides: Partial<PreparedRunPostSubmission["run"]> = {},
  metadataValue: PreparedRunPostSubmission["metadata"] = metadata("claude-code", "root"),
  privacyMode: "full" | "metadata" = "full",
  turnId = "turn-snapshot",
): LifecycleSnapshotCaptureInput {
  return {
    turnId,
    eventId,
    submission: post(
      PARENT_ID,
      metadataValue,
      {
        start_time: "2026-10-10T12:00:00.000Z",
        trace_id: PARENT_ID,
        dotted_order: PARENT_DOTTED_ORDER,
        ...runOverrides,
      },
      privacyMode,
    ),
    turnEvidence: evidence(),
  };
}

function scope(turnId: string, eventId: string, sessionId = "session-1"): CaptureScope {
  return { integration: "claude-code", sessionId, turnId, eventId };
}

function capturePost(
  targetBridge: ReturnType<typeof createLifecycleBridge>,
  eventScope: CaptureScope,
  runId: string,
  input: string,
  output: string,
  closureState: LifecycleTurnEvidence["closureState"] = "open",
) {
  return targetBridge.capture({
    turnId: eventScope.turnId,
    eventId: eventScope.eventId,
    submission: post(runId, metadata("claude-code", "root"), {
      inputs: { prompt: input },
      outputs: { answer: output },
    }),
    turnEvidence: evidence({ rootRunId: runId, closureState }),
  });
}

async function scan(directory: string): Promise<string[]> {
  const contents: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...(await scan(path)));
    else contents.push(await readFile(path, "utf8"));
  }
  return contents;
}

beforeEach(async () => {
  requests = [];
  failChildPatches = false;
  failRequestIndexes = new Set();
  server = createServer(requestBody);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local endpoint did not start");
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

async function reconstructRedactedSnapshot(job: ReconstructionJob) {
  const source = job.sourceSnapshots![0]!;
  expect(source.submission.redactedFields).toEqual(["outputs"]);
  return {
    status: "ready" as const,
    outputs: [
      { eventId: "redacted-patch", sourceRef: source.sourceRef, submission: source.submission },
    ],
  };
}

describe("durable run lifecycle bridge", () => {
  it("preserves legacy failure counts across recreated delivery workers", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-legacy-attempts-"));
    const options = {
      storageRoot: root,
      integration: "claude-code" as const,
      sessionId: "session-1",
      writer: { destinations: [destination()], redact: false },
      policy: { maxAttempts: 3 },
    };
    const bridge = createLifecycleBridge(options);
    const input: LifecycleCaptureInput = {
      turnId: "legacy-turn",
      eventId: "legacy-event",
      submission: post(PARENT_ID, metadata("claude-code", "root")),
      turnEvidence: evidence(),
      priorDeliveryAttempts: 1,
    };
    await expect(bridge.capture(input)).resolves.toMatchObject({ status: "published" });
    failRequestIndexes = new Set([0, 1]);
    await expect(bridge.drain()).resolves.toMatchObject({ failed: 1, dropped: 0, pending: 1 });
    const restarted = createLifecycleBridge(options);
    await expect(restarted.capture(input)).resolves.toMatchObject({ status: "duplicate" });
    await expect(restarted.drain()).resolves.toMatchObject({ failed: 1, dropped: 1, pending: 0 });
    await expect(restarted.drain()).resolves.toMatchObject({ failed: 0, pending: 0 });
    expect(requests).toHaveLength(2);
    await expect(
      createCaptureStore(root).read(scope("legacy-turn", "legacy-event")),
    ).resolves.toMatchObject({ priorDeliveryAttempts: 1 });
    await expect(
      restarted.capture({ ...input, eventId: "exhausted-legacy-event", priorDeliveryAttempts: 3 }),
    ).resolves.toMatchObject({ status: "published" });
    await expect(restarted.drain()).resolves.toMatchObject({ dropped: 1, pending: 0 });
    expect(requests).toHaveLength(2);
  });

  it("sends dependent creates and patches to localhost in prerequisite order", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-dependent-"));
    const wake = vi.fn();
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
      writer: { destinations: [destination()], redact: false },
      wake,
    });
    const parent = post(PARENT_ID, metadata("claude-code", "root"), {
      start_time: "2026-10-10T12:00:00.000Z",
      trace_id: PARENT_ID,
      dotted_order: PARENT_DOTTED_ORDER,
    });
    const child = post(CHILD_ID, metadata("claude-code", "tool"), {
      run_type: "tool",
      start_time: "2026-10-10T12:00:00.001Z",
      parent_run_id: PARENT_ID,
      trace_id: PARENT_ID,
      dotted_order: CHILD_DOTTED_ORDER,
    });
    const patch: PreparedRunPatchSubmission = {
      operation: "patch",
      integration: "claude-code",
      privacyMode: "full",
      metadata: metadata("claude-code", "tool"),
      run: {
        id: CHILD_ID,
        name: "test run",
        run_type: "tool",
        start_time: "2026-10-10T12:00:00.001Z",
        parent_run_id: PARENT_ID,
        trace_id: PARENT_ID,
        dotted_order: CHILD_DOTTED_ORDER,
      },
      privacyContext: { status: "completed" },
      patch: { fields: ["outputs"], values: { outputs: { result: "done" } } },
    };
    const parentScope = scope("turn-parent", "c-parent");
    const childScope = scope("turn-child", "b-child");
    const patchScope = scope("turn-child", "a-patch");

    await expect(
      bridge.capture({
        turnId: patchScope.turnId,
        eventId: patchScope.eventId,
        submission: patch,
        turnEvidence: evidence({ closureState: "authoritative" }),
        dependencies: [childScope],
      }),
    ).resolves.toMatchObject({ status: "published" });
    await expect(
      bridge.capture({
        turnId: childScope.turnId,
        eventId: childScope.eventId,
        submission: child,
        turnEvidence: evidence(),
        dependencies: [parentScope],
      }),
    ).resolves.toMatchObject({ status: "published" });
    await expect(
      bridge.capture({
        turnId: parentScope.turnId,
        eventId: parentScope.eventId,
        submission: parent,
        turnEvidence: evidence({ childRunIds: [CHILD_ID] }),
      }),
    ).resolves.toMatchObject({ status: "published" });

    await expect(bridge.drain()).resolves.toMatchObject({
      status: "drained",
      delivered: 3,
      pending: 0,
    });
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/api/v1/runs"],
      ["POST", "/api/v1/runs"],
      ["PATCH", `/api/v1/runs/${CHILD_ID}`],
    ]);
    expect(requests.map(({ method, payload }) => [method, payload["id"]])).toEqual([
      ["POST", PARENT_ID],
      ["POST", CHILD_ID],
      ["PATCH", undefined],
    ]);
    expect(
      requests.slice(0, 2).map(({ payload }) => ({
        id: payload["id"],
        run_type: payload["run_type"],
        trace_id: payload["trace_id"],
        dotted_order: payload["dotted_order"],
        parent_run_id: payload["parent_run_id"],
      })),
    ).toEqual([
      {
        id: PARENT_ID,
        run_type: "chain",
        trace_id: PARENT_ID,
        dotted_order: PARENT_DOTTED_ORDER,
        parent_run_id: undefined,
      },
      {
        id: CHILD_ID,
        run_type: "tool",
        trace_id: PARENT_ID,
        dotted_order: CHILD_DOTTED_ORDER,
        parent_run_id: PARENT_ID,
      },
    ]);
    expect(wake).toHaveBeenCalledTimes(4);
  });

  it("stores only projected metadata-mode content and structural turn evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-privacy-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "openai-codex",
      sessionId: "session-private",
      writer: { destinations: [destination()], redact: false },
    });
    const unsafeEvidence: LifecycleTurnEvidence & Record<string, unknown> = {
      childRunIds: [],
      closureState: "provisional",
      transcript: PRIVATE_MARKER,
    };
    const submission = post(
      PARENT_ID,
      {
        ...metadata("openai-codex", "root"),
        base: { private: PRIVATE_MARKER },
        runSpecific: { private: PRIVATE_MARKER },
        providerMetadata: {
          ls_provider: PRIVATE_MARKER,
          ls_raw_aggregated_usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
      {
        start_time: "2026-10-10T12:00:00.000Z",
        inputs: { prompt: PRIVATE_MARKER },
        outputs: { answer: PRIVATE_MARKER },
        error: PRIVATE_MARKER,
        tags: [PRIVATE_MARKER],
        serialized: { private: PRIVATE_MARKER },
        events: [{ name: "tool", message: PRIVATE_MARKER }] as never,
        reference_example_id: PRIVATE_MARKER,
      },
      "metadata",
    );

    await expect(
      bridge.capture({
        turnId: "turn-private",
        eventId: "event-private",
        submission,
        turnEvidence: unsafeEvidence,
      }),
    ).resolves.toMatchObject({ status: "published" });

    const contents = (await scan(root)).join("\n");
    expect(contents).not.toContain(PRIVATE_MARKER);
    const records = await createCaptureStore(root).enumerate("openai-codex", "session-private");
    expect(records).toHaveLength(1);
    const record = records[0]!.record;
    expect(record.metadataProvenance).toMatchObject({
      integration: "openai-codex",
      providerMetadata: { ls_raw_aggregated_usage: { input_tokens: 3, output_tokens: 1 } },
    });
    expect(record.metadataProvenance).not.toHaveProperty("base");
    expect(record.metadataProvenance).not.toHaveProperty("runSpecific");
    expect(
      (record.metadataProvenance as Record<string, unknown>)["providerMetadata"],
    ).not.toHaveProperty("ls_provider");
    expect(record.turnEvidence).toEqual({
      childRunIds: [],
      closureState: "provisional",
      attributionReady: false,
    });
    expect(record.normalizedPayload).toMatchObject({
      privacyContext: { status: "error" },
      run: {
        inputs: { messages: [{ role: "user", content: MUTED_TRACE_CONTENT }] },
        outputs: { messages: [{ role: "assistant", content: MUTED_TRACE_CONTENT }] },
      },
    });

    await expect(bridge.drain()).resolves.toMatchObject({ delivered: 1, pending: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.payload["extra"]).toMatchObject({
      metadata: { status: "error", ls_tracing_mode: "metadata" },
    });
    expect(JSON.stringify(requests[0]?.payload)).not.toContain(PRIVATE_MARKER);
  });

  it("persists metadata-mode patches with a projected mask, status, and provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-patch-privacy-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "openai-codex",
      sessionId: "session-patch-private",
      writer: { destinations: [destination()], redact: false },
    });
    const submission: PreparedRunPatchSubmission = {
      operation: "patch",
      integration: "openai-codex",
      privacyMode: "metadata",
      metadata: {
        ...metadata("openai-codex", "root"),
        base: { private: PRIVATE_MARKER },
        runSpecific: { private: PRIVATE_MARKER },
        providerMetadata: {
          ls_provider: PRIVATE_MARKER,
          ls_raw_aggregated_usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
      run: {
        id: PARENT_ID,
        name: "test run",
        run_type: "chain",
        start_time: "2026-10-10T12:00:00.000Z",
        trace_id: PARENT_ID,
        dotted_order: "20261010T120000000Z11111111-1111-4111-8111-111111111111",
      },
      privacyContext: { status: "completed" },
      patch: {
        fields: [
          "inputs",
          "outputs",
          "error",
          "tags",
          "serialized",
          "events",
          "reference_example_id",
        ],
        values: {
          inputs: { prompt: PRIVATE_MARKER },
          outputs: { answer: PRIVATE_MARKER },
          error: PRIVATE_MARKER,
          tags: [PRIVATE_MARKER],
          serialized: { private: PRIVATE_MARKER },
          events: [{ message: PRIVATE_MARKER }] as never,
          reference_example_id: PRIVATE_MARKER,
        },
      },
    };
    const captureScope: CaptureScope = {
      integration: "openai-codex",
      sessionId: "session-patch-private",
      turnId: "turn-patch-private",
      eventId: "event-patch-private",
    };

    await expect(
      bridge.capture({
        turnId: captureScope.turnId,
        eventId: captureScope.eventId,
        submission,
        turnEvidence: evidence({ closureState: "authoritative" }),
      }),
    ).resolves.toMatchObject({ status: "published" });

    const record = (await createCaptureStore(root).read(captureScope))!;
    const payload = record.normalizedPayload as unknown as {
      privacyContext: { status: string };
      patch: { fields: string[]; values: Record<string, unknown> };
    };
    expect(JSON.stringify(record)).not.toContain(PRIVATE_MARKER);
    expect(payload.privacyContext.status).toBe("completed");
    expect(payload.patch.fields).toEqual(["inputs", "outputs", "serialized"]);
    expect(payload.patch.values["inputs"]).toEqual({
      messages: [{ role: "user", content: MUTED_TRACE_CONTENT }],
    });
    expect(payload.patch.values["outputs"]).toEqual({
      messages: [{ role: "assistant", content: MUTED_TRACE_CONTENT }],
    });
    expect(payload.patch.values["serialized"]).toEqual({});
    expect(record.metadataProvenance).toMatchObject({
      integration: "openai-codex",
      threadId: "thread-1",
      providerMetadata: { ls_raw_aggregated_usage: { input_tokens: 3, output_tokens: 1 } },
    });
    expect(record.metadataProvenance).not.toHaveProperty("base");
    expect(record.metadataProvenance).not.toHaveProperty("runSpecific");
    expect(
      (record.metadataProvenance as Record<string, unknown>)["providerMetadata"],
    ).not.toHaveProperty("ls_provider");

    await expect(bridge.drain()).resolves.toMatchObject({ delivered: 1, pending: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.payload["extra"]).toMatchObject({
      metadata: { status: "completed", ls_tracing_mode: "metadata" },
    });
    expect(JSON.stringify(requests[0]?.payload)).not.toContain(PRIVATE_MARKER);
  });

  it("adds repository metadata to completed children with a sparse patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-settlement-child-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-settlement-child",
      writer: { destinations: [destination()], redact: false },
    });
    const turnId = "turn-settlement-child";
    const rootScope = scope(turnId, "event-root", "session-settlement-child");
    const rootSubmission = post(
      PARENT_ID,
      {
        ...metadata("claude-code", "root"),
        base: {
          repository_name: "acme/project",
          repository_provider: "github",
          repository_url: "https://github.com/acme/project",
          git_branch: "main",
          git_commit_sha: "abc123",
        },
      },
      {
        start_time: "2026-10-10T12:00:00.000Z",
        trace_id: PARENT_ID,
        dotted_order: PARENT_DOTTED_ORDER,
      },
    );
    const childSubmission = post(CHILD_ID, metadata("claude-code", "tool"), {
      run_type: "tool",
      start_time: "2026-10-10T12:00:00.001Z",
      end_time: "2026-10-10T12:00:00.010Z",
      outputs: { result: "done" },
      parent_run_id: PARENT_ID,
      trace_id: PARENT_ID,
      dotted_order: CHILD_DOTTED_ORDER,
    });

    await bridge.capture({
      turnId,
      eventId: "event-child",
      submission: childSubmission,
      turnEvidence: evidence({
        rootRunId: PARENT_ID,
        childRunIds: [CHILD_ID],
        closureState: "authoritative",
      }),
      dependencies: [rootScope],
    });
    await bridge.capture({
      turnId,
      eventId: rootScope.eventId,
      submission: rootSubmission,
      turnEvidence: evidence({
        rootRunId: PARENT_ID,
        childRunIds: [CHILD_ID],
        closureState: "authoritative",
      }),
    });

    await expect(bridge.drain()).resolves.toMatchObject({
      status: "drained",
      delivered: 3,
      pending: 0,
    });
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/api/v1/runs"],
      ["POST", "/api/v1/runs"],
      ["PATCH", `/api/v1/runs/${CHILD_ID}`],
    ]);
    expect(requests[1]?.payload).not.toHaveProperty("end_time");
    expect(requests[2]?.payload["end_time"]).toBe("2026-10-10T12:00:00.010Z");
    expect(requests[2]?.payload["extra"]).toMatchObject({
      metadata: {
        repository_name: "acme/project",
        repository_provider: "github",
        repository_url: "https://github.com/acme/project",
        git_branch: "main",
        git_commit_sha: "abc123",
      },
    });
  });

  it("preserves field redaction through saved captures and reconstruction restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-redacted-restart-"));
    const sessionId = "redacted-restart";
    const turnId = "redacted-turn";
    const replacement = `${PRIVATE_MARKER}_replaced`;
    const options = {
      storageRoot: root,
      integration: "claude-code" as const,
      sessionId,
      writer: {
        destinations: [destination()],
        redact: true,
        redactExtraRules: [{ pattern: PRIVATE_MARKER, replace: replacement }],
      },
    };
    const bridge = createLifecycleBridge(options);
    const turnEvidence = { rootRunId: PARENT_ID, childRunIds: [], closureState: "open" as const };
    const submission = post(PARENT_ID, metadata("claude-code", "root"), {
      start_time: "2026-10-10T12:00:00.000Z",
      trace_id: PARENT_ID,
      dotted_order: PARENT_DOTTED_ORDER,
      inputs: { value: replacement },
    });
    const captured = await bridge.capture({
      turnId,
      eventId: "redacted-post",
      submission: { ...submission, redactedFields: ["inputs"] },
      turnEvidence,
    });
    expect(captured.status).toBe("published");

    const queued = createReconstructionWorker({
      ...options,
      bridge,
      reconstruct: reconstructRedactedSnapshot,
    });
    await queued.enqueue({
      turnId,
      eventId: "redacted-job",
      privacyMode: "full",
      sourceRefs: ["redacted-source"],
      turnEvidence,
      sourceSnapshots: [
        {
          sourceRef: "redacted-source",
          sourceAgeStartedAtMs: Date.now(),
          submission: {
            operation: "patch",
            integration: "claude-code",
            privacyMode: "full",
            redactedFields: ["outputs"],
            metadata: metadata("claude-code", "root"),
            privacyContext: { status: "running" },
            run: {
              id: PARENT_ID,
              name: submission.run.name,
              run_type: submission.run.run_type,
              start_time: "2026-10-10T12:00:00.000Z",
              trace_id: PARENT_ID,
              dotted_order: PARENT_DOTTED_ORDER,
            },
            patch: { fields: ["outputs"], values: { outputs: { value: replacement } } },
          },
        },
      ],
    });
    const resumed = createLifecycleBridge(options);
    await resumed.drain();
    const worker = createReconstructionWorker({
      ...options,
      bridge: resumed,
      reconstruct: reconstructRedactedSnapshot,
    });
    expect(await worker.drain()).toMatchObject({ captured: 1 });
    await resumed.drain();
    expect(requests[0]?.payload).toMatchObject({ inputs: { value: replacement } });
    expect(requests[1]?.payload).toMatchObject({ outputs: { value: replacement } });
  });

  it("restores a parent end time after child receipts arrive from another turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-cross-turn-closure-"));
    const sessionId = "session-cross-turn-closure";
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      writer: { destinations: [destination()], redact: false },
    });
    const parentTurnId = "turn-parent-closure";
    const childTurnId = "turn-child-closure";
    const rootScope = scope(parentTurnId, "event-parent-root", sessionId);
    const parentEvidence = evidence({
      rootRunId: PARENT_ID,
      childRunIds: [CHILD_ID],
      closureState: "authoritative",
    });
    const rootSubmission = post(
      PARENT_ID,
      metadata("claude-code", "root"),
      {
        start_time: "2026-10-10T12:00:00.000Z",
        end_time: "2026-10-10T12:00:01.000Z",
        trace_id: PARENT_ID,
        dotted_order: PARENT_DOTTED_ORDER,
      },
      "metadata",
    );
    const childSubmission = post(
      CHILD_ID,
      {
        ...metadata("claude-code", "subagent"),
        base: {
          repository_name: "acme/project",
          repository_provider: "github",
          repository_url: "https://github.com/acme/project",
          git_branch: "main",
          ls_attribution_identifier: "author-1",
        },
      },
      {
        run_type: "chain",
        start_time: "2026-10-10T12:00:00.100Z",
        end_time: "2026-10-10T12:00:00.900Z",
        parent_run_id: PARENT_ID,
        trace_id: PARENT_ID,
        dotted_order: CHILD_DOTTED_ORDER,
      },
      "metadata",
    );

    await bridge.capture({
      turnId: parentTurnId,
      eventId: rootScope.eventId,
      submission: rootSubmission,
      turnEvidence: parentEvidence,
    });
    await bridge.capture({
      turnId: childTurnId,
      eventId: "event-child-root",
      submission: childSubmission,
      turnEvidence: evidence({
        rootRunId: CHILD_ID,
        childRunIds: [],
        closureState: "authoritative",
      }),
      dependencies: [rootScope],
    });

    await expect(bridge.drain()).resolves.toMatchObject({
      status: "drained",
      delivered: 3,
      pending: 0,
    });
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/api/v1/runs"],
      ["POST", "/api/v1/runs"],
      ["PATCH", `/api/v1/runs/${PARENT_ID}`],
    ]);
    expect(requests[0]?.payload).not.toHaveProperty("end_time");
    expect(requests[2]?.payload["end_time"]).toBe("2026-10-10T12:00:01.000Z");
  });

  it("keeps a parent end time when a child from another turn is already delivered", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-cross-turn-receipt-"));
    const sessionId = "session-cross-turn-receipt";
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      writer: { destinations: [destination()], redact: false },
    });
    const childTurnId = "turn-child-receipt";
    await bridge.capture({
      turnId: childTurnId,
      eventId: "event-child-receipt",
      submission: post(
        CHILD_ID,
        metadata("claude-code", "subagent"),
        {
          run_type: "chain",
          start_time: "2026-10-10T12:00:00.100Z",
          end_time: "2026-10-10T12:00:00.900Z",
          parent_run_id: PARENT_ID,
          trace_id: PARENT_ID,
          dotted_order: CHILD_DOTTED_ORDER,
        },
        "metadata",
      ),
      turnEvidence: evidence({
        rootRunId: CHILD_ID,
        childRunIds: [],
        closureState: "authoritative",
      }),
    });
    await expect(bridge.drain()).resolves.toMatchObject({ delivered: 1, pending: 0 });

    const requestStart = requests.length;
    await bridge.capture({
      turnId: "turn-parent-receipt",
      eventId: "event-parent-receipt",
      submission: post(
        PARENT_ID,
        metadata("claude-code", "root"),
        {
          start_time: "2026-10-10T12:00:00.000Z",
          end_time: "2026-10-10T12:00:01.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
        },
        "metadata",
      ),
      turnEvidence: evidence({
        rootRunId: PARENT_ID,
        childRunIds: [CHILD_ID],
        closureState: "authoritative",
      }),
    });
    await expect(bridge.drain()).resolves.toMatchObject({ status: "drained" });

    const parentPost = requests
      .slice(requestStart)
      .find(({ method, payload }) => method === "POST" && payload["id"] === PARENT_ID);
    expect(parentPost?.payload["end_time"]).toBe("2026-10-10T12:00:01.000Z");
  });

  it("keeps a parent open while a child from another turn is undelivered", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-cross-turn-pending-child-"));
    const sessionId = "session-cross-turn-pending-child";
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      writer: { destinations: [destination()], redact: false },
    });
    const parentTurnId = "turn-parent-pending-child";
    const parentScope = scope(parentTurnId, "event-parent-pending-child", sessionId);
    await bridge.capture({
      turnId: parentTurnId,
      eventId: parentScope.eventId,
      submission: post(
        PARENT_ID,
        metadata("claude-code", "root"),
        {
          start_time: "2026-10-10T12:00:00.000Z",
          end_time: "2026-10-10T12:00:01.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
        },
        "metadata",
      ),
      turnEvidence: evidence({
        rootRunId: PARENT_ID,
        childRunIds: [CHILD_ID],
        closureState: "authoritative",
      }),
    });
    await bridge.capture({
      turnId: "turn-child-pending-delivery",
      eventId: "event-child-pending-delivery",
      submission: post(
        CHILD_ID,
        metadata("claude-code", "subagent"),
        {
          run_type: "chain",
          start_time: "2026-10-10T12:00:00.100Z",
          end_time: "2026-10-10T12:00:00.900Z",
          parent_run_id: PARENT_ID,
          trace_id: PARENT_ID,
          dotted_order: CHILD_DOTTED_ORDER,
        },
        "metadata",
      ),
      turnEvidence: evidence({
        rootRunId: CHILD_ID,
        childRunIds: [],
        closureState: "authoritative",
      }),
      dependencies: [parentScope],
    });

    failRequestIndexes = new Set([1]);
    await bridge.drain();
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/api/v1/runs"],
      ["POST", "/api/v1/runs"],
    ]);
    expect(requests[0]?.payload).not.toHaveProperty("end_time");

    failRequestIndexes.clear();
    const retryStart = requests.length;
    await bridge.drain();
    expect(
      requests
        .slice(retryStart)
        .some(
          ({ method, path, payload }) =>
            method === "PATCH" &&
            path === `/api/v1/runs/${PARENT_ID}` &&
            payload["end_time"] === "2026-10-10T12:00:01.000Z",
        ),
    ).toBe(true);
  });

  it("delivers generated patches in dependency order when their timestamps match", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-settlement-order-"));
    const sessionId = "session-settlement-order";
    const turnId = "turn-settlement-order";
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T12:00:00.000Z"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      writer: { destinations: [destination()], redact: false },
      policy: { maxAttempts: 100 },
    });
    const rootScope = scope(turnId, "event-root-order", sessionId);
    const childSourceEventId = "event-child-order";
    const evidenceForTurn = evidence({
      rootRunId: PARENT_ID,
      childRunIds: [CHILD_ID],
      closureState: "authoritative",
    });
    const rootRevision = (branch: string): PreparedRunPatchSubmission => ({
      operation: "patch",
      integration: "claude-code",
      privacyMode: "full",
      metadata: repositoryMetadata(branch),
      run: {
        id: PARENT_ID,
        name: "root run",
        run_type: "chain",
        start_time: "2026-10-10T12:00:00.000Z",
        trace_id: PARENT_ID,
        dotted_order: PARENT_DOTTED_ORDER,
      },
      privacyContext: { status: "completed" },
      patch: { fields: [], values: {} },
    });
    const generatedEventId = (sourceEventIds: string[], branch: string) => {
      const dependencies = sourceEventIds
        .map((eventId) => scope(turnId, eventId, sessionId))
        .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const revision = JSON.stringify({
        turnId,
        runId: CHILD_ID,
        rootRunId: PARENT_ID,
        childRunIds: [CHILD_ID],
        dependencies,
        attribution: { repository_name: "acme/project", git_branch: branch },
      });
      return `turn-settlement-${createHash("sha256").update(revision).digest("hex")}`;
    };
    const generatedRecords = async () =>
      (await createCaptureStore(root).enumerate("claude-code", sessionId)).filter(
        ({ record }) => record.eventKind === "run-settlement-patch" && record.runId === CHILD_ID,
      );
    const findEarlierSourceId = (
      sourceEventIds: string[],
      branch: string,
      previousGeneratedId: string,
    ) =>
      Array.from({ length: 10_000 }, (_, index) => `root-revision-${branch}-${index}`).find(
        (eventId) => generatedEventId([...sourceEventIds, eventId], branch) < previousGeneratedId,
      );

    try {
      failChildPatches = true;
      await bridge.capture({
        turnId,
        eventId: rootScope.eventId,
        submission: post(PARENT_ID, repositoryMetadata("main"), {
          start_time: "2026-10-10T12:00:00.000Z",
          end_time: "2026-10-10T12:00:01.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
        }),
        turnEvidence: evidenceForTurn,
      });
      await bridge.capture({
        turnId,
        eventId: childSourceEventId,
        submission: post(
          CHILD_ID,
          { ...metadata("claude-code", "tool"), agentType: "subagent" },
          {
            run_type: "tool",
            start_time: "2026-10-10T12:00:00.001Z",
            end_time: "2026-10-10T12:00:01.000Z",
            parent_run_id: PARENT_ID,
            trace_id: PARENT_ID,
            dotted_order: CHILD_DOTTED_ORDER,
          },
        ),
        turnEvidence: evidenceForTurn,
        dependencies: [rootScope],
      });

      await expect(bridge.drain()).resolves.toMatchObject({
        status: "drained",
        delivered: 3,
        failed: 1,
        pending: 1,
      });
      const firstGenerated = (await generatedRecords())[0]?.record;
      expect(firstGenerated).toBeDefined();
      if (firstGenerated === undefined) throw new Error("First settlement patch was not captured");
      expect(firstGenerated.eventId).toBe(
        generatedEventId([rootScope.eventId, childSourceEventId], "main"),
      );

      const secondSourceId = findEarlierSourceId(
        [rootScope.eventId, childSourceEventId],
        "branch-b",
        firstGenerated.eventId,
      );
      expect(secondSourceId).toBeDefined();
      if (secondSourceId === undefined) throw new Error("Could not select branch-b source ID");
      await bridge.capture({
        turnId,
        eventId: secondSourceId,
        submission: rootRevision("branch-b"),
        turnEvidence: evidenceForTurn,
        dependencies: [rootScope],
      });
      await expect(bridge.drain()).resolves.toMatchObject({ status: "drained", pending: 2 });
      const secondGenerated = (await generatedRecords()).find(
        ({ record }) => record.eventId !== firstGenerated.eventId,
      )?.record;
      expect(secondGenerated).toBeDefined();
      if (secondGenerated === undefined)
        throw new Error("Second settlement patch was not captured");
      expect(secondGenerated.eventId).toBe(
        generatedEventId([rootScope.eventId, childSourceEventId, secondSourceId], "branch-b"),
      );

      const thirdSourceId = findEarlierSourceId(
        [rootScope.eventId, childSourceEventId, secondSourceId],
        "branch-c",
        secondGenerated.eventId,
      );
      expect(thirdSourceId).toBeDefined();
      if (thirdSourceId === undefined) throw new Error("Could not select branch-c source ID");
      await bridge.capture({
        turnId,
        eventId: thirdSourceId,
        submission: rootRevision("branch-c"),
        turnEvidence: evidenceForTurn,
        dependencies: [scope(turnId, secondSourceId, sessionId)],
      });
      await expect(bridge.drain()).resolves.toMatchObject({ status: "drained", pending: 3 });
      const thirdGenerated = (await generatedRecords()).find(
        ({ record }) =>
          record.eventId !== firstGenerated.eventId && record.eventId !== secondGenerated.eventId,
      )?.record;
      expect(thirdGenerated).toBeDefined();
      if (thirdGenerated === undefined) throw new Error("Third settlement patch was not captured");
      expect(thirdGenerated.eventId).toBe(
        generatedEventId(
          [rootScope.eventId, childSourceEventId, secondSourceId, thirdSourceId],
          "branch-c",
        ),
      );

      const finalDrainStart = requests.length;
      failChildPatches = false;
      await expect(bridge.drain()).resolves.toMatchObject({
        status: "drained",
        delivered: 3,
        pending: 0,
      });
      const deliveredBranches = requests
        .slice(finalDrainStart)
        .filter(({ method, path }) => method === "PATCH" && path === `/api/v1/runs/${CHILD_ID}`)
        .map(
          ({ payload }) =>
            (payload["extra"] as { metadata: { git_branch: string } }).metadata.git_branch,
        );
      expect(deliveredBranches).toEqual(["main", "branch-b", "branch-c"]);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps root repository details out of a metadata-mode settlement record", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-settlement-metadata-mode-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-settlement-metadata-mode",
      writer: { destinations: [destination()], redact: false },
    });
    const turnId = "turn-settlement-metadata-mode";
    const sessionId = "session-settlement-metadata-mode";
    const marker = "private-root-repo-marker";
    const rootScope = scope(turnId, "event-root", sessionId);
    const rootMetadata = {
      ...metadata("claude-code", "root"),
      base: {
        repository_name: "private/project",
        repository_url: `https://private.invalid/${marker}`,
        git_branch: "private-branch",
      },
    };
    const childMetadata = { ...metadata("claude-code", "tool"), agentType: "subagent" as const };
    const childSubmission = post(
      CHILD_ID,
      childMetadata,
      {
        run_type: "tool",
        start_time: "2026-10-10T12:00:00.001Z",
        end_time: "2026-10-10T12:00:00.010Z",
        error: "synthetic tool error",
        parent_run_id: PARENT_ID,
        trace_id: PARENT_ID,
        dotted_order: CHILD_DOTTED_ORDER,
      },
      "metadata",
    );
    const turnEvidence = evidence({
      rootRunId: PARENT_ID,
      childRunIds: [CHILD_ID],
      closureState: "authoritative",
    });

    await bridge.capture({
      turnId,
      eventId: rootScope.eventId,
      submission: post(
        PARENT_ID,
        rootMetadata,
        {
          start_time: "2026-10-10T12:00:00.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
          end_time: "2026-10-10T12:00:00.010Z",
        },
        "metadata",
      ),
      turnEvidence,
    });
    await bridge.capture({
      turnId,
      eventId: "event-child-metadata-mode",
      submission: childSubmission,
      turnEvidence,
      dependencies: [rootScope],
    });

    await expect(bridge.drain()).resolves.toMatchObject({
      status: "drained",
      delivered: 4,
      pending: 0,
      settlement: { turns: [{ status: "settled", patches: 2 }] },
    });
    const captures = await createCaptureStore(root).enumerate("claude-code", sessionId);
    const sourceChild = captures.find(
      ({ record }) => record.eventId === "event-child-metadata-mode",
    )?.record;
    const sourceRoot = captures.find(({ record }) => record.eventId === rootScope.eventId)?.record;
    const settlements = captures.filter(
      ({ record }) => record.eventKind === "run-settlement-patch" && record.runId === CHILD_ID,
    );
    const rootSettlement = captures.find(
      ({ record }) => record.eventKind === "run-settlement-patch" && record.runId === PARENT_ID,
    )?.record;

    expect(JSON.stringify(sourceRoot)).not.toContain(marker);
    expect(JSON.stringify(sourceChild)).not.toContain(marker);
    expect(settlements).toHaveLength(1);
    expect(rootSettlement).toBeDefined();
    expect(JSON.stringify(rootSettlement)).not.toContain(marker);
    expect(JSON.stringify(settlements[0]?.record)).not.toContain(marker);
    expect(requests.slice(0, 2).map(({ payload }) => payload["end_time"])).toEqual([
      undefined,
      undefined,
    ]);
    expect(requests[1]?.payload["extra"]).toMatchObject({ metadata: { status: "error" } });
    expect(requests[2]?.payload["extra"]).toMatchObject({ metadata: { status: "completed" } });
    expect(requests[3]?.payload["extra"]).toMatchObject({ metadata: { status: "error" } });
  });

  it("keeps a root open until every child destination receipt arrives", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-root-receipts-"));
    const sessionId = "session-root-receipts";
    const turnId = "turn-root-receipts";
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      writer: {
        destinations: [
          destination(),
          {
            apiKey: "synthetic-lifecycle-key-two",
            apiUrl: endpoint,
            projectName: "lifecycle-test-two",
          },
        ],
        redact: false,
      },
    });
    const rootScope = scope(turnId, "event-root-receipts", sessionId);
    const turnEvidence = evidence({
      rootRunId: PARENT_ID,
      childRunIds: [CHILD_ID],
      closureState: "authoritative",
    });
    const rootMetadata = {
      ...metadata("claude-code", "root"),
      base: { repository_name: "acme/project" },
    };
    await bridge.capture({
      turnId,
      eventId: rootScope.eventId,
      submission: post(PARENT_ID, rootMetadata, {
        start_time: "2026-10-10T12:00:00.000Z",
        end_time: "2026-10-10T12:00:01.000Z",
        trace_id: PARENT_ID,
        dotted_order: PARENT_DOTTED_ORDER,
      }),
      turnEvidence,
    });
    await bridge.capture({
      turnId,
      eventId: "event-child-receipts",
      submission: post(CHILD_ID, metadata("claude-code", "tool"), {
        run_type: "tool",
        start_time: "2026-10-10T12:00:00.001Z",
        parent_run_id: PARENT_ID,
        trace_id: PARENT_ID,
        dotted_order: CHILD_DOTTED_ORDER,
      }),
      turnEvidence,
      dependencies: [rootScope],
    });

    failRequestIndexes = new Set([3]);
    await expect(bridge.drain()).resolves.toMatchObject({
      status: "drained",
      delivered: 3,
      failed: 1,
      pending: 1,
    });
    expect(requests.slice(0, 2).map(({ payload }) => payload["end_time"])).toEqual([
      undefined,
      undefined,
    ]);

    const rootEndTimePatch: PreparedRunPatchSubmission = {
      operation: "patch",
      integration: "claude-code",
      privacyMode: "full",
      metadata: rootMetadata,
      run: {
        id: PARENT_ID,
        name: "test run",
        run_type: "chain",
        start_time: "2026-10-10T12:00:00.000Z",
        trace_id: PARENT_ID,
        dotted_order: PARENT_DOTTED_ORDER,
      },
      privacyContext: { status: "completed" },
      patch: {
        fields: ["end_time"],
        values: { end_time: "2026-10-10T12:00:01.000Z" },
      },
    };
    await bridge.capture({
      turnId,
      eventId: "event-root-end-time-revision",
      submission: rootEndTimePatch,
      turnEvidence,
      dependencies: [rootScope],
    });
    const retryIndex = requests.length;
    failRequestIndexes = new Set([retryIndex]);
    await bridge.drain();
    const rootRevisionRequests = requests.slice(retryIndex + 1);
    expect(
      rootRevisionRequests.filter(
        ({ method, path }) => method === "PATCH" && path === `/api/v1/runs/${PARENT_ID}`,
      ),
    ).toHaveLength(2);
    expect(
      rootRevisionRequests
        .filter(({ method, path }) => method === "PATCH" && path === `/api/v1/runs/${PARENT_ID}`)
        .map(({ payload }) => payload["end_time"]),
    ).toEqual([undefined, undefined]);

    failRequestIndexes.clear();
    const settlementStart = requests.length;
    await bridge.drain();
    expect(
      requests
        .slice(settlementStart)
        .some(
          ({ method, path, payload }) =>
            method === "PATCH" &&
            path === `/api/v1/runs/${PARENT_ID}` &&
            payload["end_time"] === "2026-10-10T12:00:01.000Z",
        ),
    ).toBe(true);
  });

  it("keeps a resolved root end time even when child receipts are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-root-resolved-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-root-resolved",
      writer: { destinations: [destination()], redact: false },
    });
    const turnId = "turn-root-resolved";
    const turnEvidence = evidence({
      rootRunId: PARENT_ID,
      childRunIds: [CHILD_ID],
      closureState: "authoritative",
    });
    await bridge.capture({
      turnId,
      eventId: "event-root-resolved",
      submission: post(
        PARENT_ID,
        {
          ...metadata("claude-code", "root"),
          base: { repository_name: "acme/project", ls_attribution_identifier: "Owner" },
        },
        {
          start_time: "2026-10-10T12:00:00.000Z",
          end_time: "2026-10-10T12:00:01.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
        },
      ),
      turnEvidence,
    });

    await bridge.drain();

    expect(requests[0]?.payload["end_time"]).toBe("2026-10-10T12:00:01.000Z");
  });

  it("restores muted end times after a restart without attribution", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-restart-end-time-"));
    const sessionId = "session-restart-end-time";
    const turnId = "turn-restart-end-time";
    const firstBridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      writer: { destinations: [destination()], redact: false },
    });
    const turnEvidence = evidence({
      rootRunId: PARENT_ID,
      childRunIds: [CHILD_ID],
      closureState: "provisional",
    });
    const rootScope = scope(turnId, "event-root-restart", sessionId);
    const marker = "private-muted-end-time-marker";
    await firstBridge.capture({
      turnId,
      eventId: rootScope.eventId,
      submission: post(
        PARENT_ID,
        { ...metadata("claude-code", "root"), base: { private: marker } },
        {
          start_time: "2026-10-10T12:00:00.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
        },
        "metadata",
      ),
      turnEvidence,
    });
    await firstBridge.capture({
      turnId,
      eventId: "event-child-restart-post",
      submission: post(
        CHILD_ID,
        { ...metadata("claude-code", "tool"), base: { private: marker } },
        {
          run_type: "tool",
          start_time: "2026-10-10T12:00:00.001Z",
          end_time: "2026-10-10T12:00:01.000Z",
          inputs: { prompt: marker },
          outputs: { result: marker },
          parent_run_id: PARENT_ID,
          trace_id: PARENT_ID,
          dotted_order: CHILD_DOTTED_ORDER,
        },
        "metadata",
      ),
      turnEvidence,
      dependencies: [rootScope],
    });
    await firstBridge.capture({
      turnId,
      eventId: "event-child-restart-sparse",
      submission: {
        operation: "patch",
        integration: "claude-code",
        privacyMode: "metadata",
        metadata: metadata("claude-code", "tool"),
        run: {
          id: CHILD_ID,
          name: "test run",
          run_type: "tool",
          start_time: "2026-10-10T12:00:00.001Z",
          parent_run_id: PARENT_ID,
          trace_id: PARENT_ID,
          dotted_order: CHILD_DOTTED_ORDER,
        },
        privacyContext: { status: "completed" },
        patch: { fields: ["outputs"], values: { outputs: { result: marker } } },
      },
      turnEvidence,
      dependencies: [scope(turnId, "event-child-restart-post", sessionId)],
    });

    await expect(firstBridge.drain()).resolves.toMatchObject({
      status: "drained",
      delivered: 3,
      settlement: { turns: [{ status: "deferred", reason: "provisional" }] },
    });
    const storedBeforeRestart = await createCaptureStore(root).enumerate("claude-code", sessionId);
    const storedChild = storedBeforeRestart.find(
      ({ record }) => record.eventId === "event-child-restart-post",
    )?.record;
    expect(storedChild?.normalizedPayload).toMatchObject({
      run: { end_time: "2026-10-10T12:00:01.000Z" },
    });
    expect(JSON.stringify(storedBeforeRestart)).not.toContain(marker);
    expect(requests[1]?.payload).not.toHaveProperty("end_time");
    expect(requests[2]?.payload).not.toHaveProperty("end_time");
    expect(requests[2]?.payload["extra"]).toMatchObject({ metadata: { status: "running" } });

    const restartedBridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      writer: { destinations: [destination()], redact: false },
    });
    await restartedBridge.capture({
      turnId,
      eventId: "event-root-authoritative-restart",
      submission: {
        operation: "patch",
        integration: "claude-code",
        privacyMode: "metadata",
        metadata: metadata("claude-code", "root"),
        run: {
          id: PARENT_ID,
          name: "test run",
          run_type: "chain",
          start_time: "2026-10-10T12:00:00.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
        },
        privacyContext: { status: "running" },
        patch: { fields: [], values: {} },
      },
      turnEvidence: { ...turnEvidence, closureState: "authoritative" },
      dependencies: [rootScope],
    });
    const settlementStart = requests.length;
    await restartedBridge.drain();

    const finalPatch = requests
      .slice(settlementStart)
      .find(
        ({ method, path, payload }) =>
          method === "PATCH" &&
          path === `/api/v1/runs/${CHILD_ID}` &&
          payload["end_time"] === "2026-10-10T12:00:01.000Z",
      );
    expect(finalPatch?.payload["extra"]).toMatchObject({ metadata: { status: "completed" } });
    expect(finalPatch?.payload["extra"]).not.toMatchObject({
      metadata: { repository_name: expect.anything() },
    });
    expect(JSON.stringify(await scan(root))).not.toContain(marker);
  });

  it("drains historical captures without attribution readiness", async () => {
    const fullRoot = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-legacy-full-"));
    const fullSessionId = "session-legacy-full";
    const fullTurnId = "turn-legacy-full";
    const fullEventId = "event-legacy-full";
    const fullScope = scope(fullTurnId, fullEventId, fullSessionId);
    const fullBridge = createLifecycleBridge({
      storageRoot: fullRoot,
      integration: "claude-code",
      sessionId: fullSessionId,
      writer: { destinations: [destination()], redact: false },
    });
    await fullBridge.capture({
      turnId: fullTurnId,
      eventId: fullEventId,
      submission: post(
        CHILD_ID,
        {
          ...metadata("claude-code", "tool"),
          base: { repository_name: "acme/project", ls_attribution_identifier: "Owner" },
        },
        {
          run_type: "tool",
          end_time: "2026-10-10T12:00:01.000Z",
        },
      ),
      turnEvidence: evidence({ closureState: "provisional" }),
    });
    const fullPath = eventPath(fullRoot, fullScope);
    const fullRecord = JSON.parse(await readFile(fullPath, "utf8")) as {
      turnEvidence: Record<string, unknown>;
    };
    delete fullRecord.turnEvidence["attributionReady"];
    await writeFile(fullPath, JSON.stringify(fullRecord));

    await expect(fullBridge.drain()).resolves.toMatchObject({ delivered: 1, pending: 0 });
    expect(requests[0]?.payload["end_time"]).toBe("2026-10-10T12:00:01.000Z");

    fullRecord.turnEvidence["attributionReady"] = "invalid";
    await writeFile(fullPath, JSON.stringify(fullRecord));
    await expect(fullBridge.drain()).rejects.toThrow("attributionReady must be a boolean");

    const metadataRoot = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-legacy-metadata-"));
    const metadataSessionId = "session-legacy-metadata";
    const metadataTurnId = "turn-legacy-metadata";
    const metadataEventId = "event-legacy-metadata";
    const metadataPath = eventPath(
      metadataRoot,
      scope(metadataTurnId, metadataEventId, metadataSessionId),
    );
    const metadataBridge = createLifecycleBridge({
      storageRoot: metadataRoot,
      integration: "claude-code",
      sessionId: metadataSessionId,
      writer: { destinations: [destination()], redact: false },
    });
    await metadataBridge.capture({
      turnId: metadataTurnId,
      eventId: metadataEventId,
      submission: post(
        CHILD_ID,
        { ...metadata("claude-code", "tool"), base: { private: "legacy-private" } },
        { run_type: "tool", end_time: "2026-10-10T12:00:02.000Z" },
        "metadata",
      ),
      turnEvidence: evidence({ closureState: "provisional" }),
    });
    const metadataRecord = JSON.parse(await readFile(metadataPath, "utf8")) as {
      turnEvidence: Record<string, unknown>;
    };
    delete metadataRecord.turnEvidence["attributionReady"];
    await writeFile(metadataPath, JSON.stringify(metadataRecord));

    const requestStart = requests.length;
    await expect(metadataBridge.drain()).resolves.toMatchObject({ delivered: 1, pending: 0 });
    expect(requests[requestStart]?.payload).not.toHaveProperty("end_time");
    expect(requests[requestStart]?.payload["extra"]).toMatchObject({
      metadata: { status: "running" },
    });
  });

  it("preserves stored metadata-mode error status on generated attribution patches", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-settlement-error-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "openai-codex",
      sessionId: "session-settlement-error",
      writer: { destinations: [destination()], redact: false },
    });
    const turnId = "turn-settlement-error";
    const rootSubmission: PreparedRunPostSubmission = {
      ...post(
        PARENT_ID,
        metadata("openai-codex", "root"),
        {
          start_time: "2026-10-10T12:00:00.000Z",
          end_time: "2026-10-10T12:00:01.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
        },
        "metadata",
      ),
      privacyContext: { status: "error" },
    };
    const childSubmission = post(
      CHILD_ID,
      {
        ...metadata("openai-codex", "tool"),
        base: {
          repository_name: "acme/project",
          repository_provider: "github",
          repository_url: "https://github.com/acme/project",
          git_branch: "main",
          git_commit_sha: "abc123",
        },
      },
      {
        run_type: "tool",
        start_time: "2026-10-10T12:00:00.001Z",
        parent_run_id: PARENT_ID,
        trace_id: PARENT_ID,
        dotted_order: CHILD_DOTTED_ORDER,
      },
    );

    await bridge.capture({
      turnId,
      eventId: "event-root",
      submission: rootSubmission,
      turnEvidence: evidence({
        rootRunId: PARENT_ID,
        childRunIds: [CHILD_ID],
        closureState: "authoritative",
      }),
    });
    await bridge.capture({
      turnId,
      eventId: "event-child",
      submission: childSubmission,
      turnEvidence: evidence({ rootRunId: PARENT_ID, childRunIds: [CHILD_ID] }),
    });

    await expect(bridge.drain()).resolves.toMatchObject({
      status: "drained",
      delivered: 3,
      pending: 0,
    });
    expect(requests).toHaveLength(3);
    expect(requests[0]?.payload["extra"]).toMatchObject({ metadata: { status: "error" } });
    expect(requests[2]?.method).toBe("PATCH");
    expect(requests[2]?.path).toBe(`/api/v1/runs/${PARENT_ID}`);
    expect(requests[2]?.payload["end_time"]).toBe("2026-10-10T12:00:01.000Z");
    expect(requests[2]?.payload["extra"]).toMatchObject({ metadata: { status: "error" } });
  });

  it("retains a defined empty SDK error patch after a later sparse status update", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-sparse-error-status-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
      writer: { destinations: [destination()], redact: false },
    });
    const turnId = "turn-sparse-error-status";
    const rootScope = scope(turnId, "event-root-sparse-error-status");
    const childScope = scope(turnId, "event-child-error-post");
    const errorScope = scope(turnId, "event-child-empty-error-patch");
    const turnEvidence = evidence({
      rootRunId: PARENT_ID,
      childRunIds: [CHILD_ID],
      closureState: "authoritative",
    });
    await bridge.capture({
      turnId,
      eventId: rootScope.eventId,
      submission: post(
        PARENT_ID,
        {
          ...metadata("claude-code", "root"),
          base: { repository_name: "acme/project", ls_attribution_identifier: "Owner" },
        },
        {
          start_time: "2026-10-10T12:00:00.000Z",
          end_time: "2026-10-10T12:00:01.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
        },
      ),
      turnEvidence,
    });
    await bridge.capture({
      turnId,
      eventId: childScope.eventId,
      submission: post(
        CHILD_ID,
        metadata("claude-code", "tool"),
        {
          run_type: "tool",
          start_time: "2026-10-10T12:00:00.001Z",
          parent_run_id: PARENT_ID,
          trace_id: PARENT_ID,
          dotted_order: CHILD_DOTTED_ORDER,
        },
        "metadata",
      ),
      turnEvidence,
      dependencies: [rootScope],
    });
    await bridge.capture({
      turnId,
      eventId: errorScope.eventId,
      submission: {
        operation: "patch",
        integration: "claude-code",
        privacyMode: "full",
        metadata: metadata("claude-code", "tool"),
        run: {
          id: CHILD_ID,
          name: "test run",
          run_type: "tool",
          start_time: "2026-10-10T12:00:00.001Z",
          parent_run_id: PARENT_ID,
          trace_id: PARENT_ID,
          dotted_order: CHILD_DOTTED_ORDER,
        },
        privacyContext: { status: "error" },
        patch: { fields: ["error"], values: { error: "" } },
      },
      turnEvidence,
      dependencies: [childScope],
    });
    await bridge.capture({
      turnId,
      eventId: "event-child-sparse-error-status",
      submission: {
        operation: "patch",
        integration: "claude-code",
        privacyMode: "metadata",
        metadata: metadata("claude-code", "tool"),
        run: {
          id: CHILD_ID,
          name: "test run",
          run_type: "tool",
          start_time: "2026-10-10T12:00:00.001Z",
          parent_run_id: PARENT_ID,
          trace_id: PARENT_ID,
          dotted_order: CHILD_DOTTED_ORDER,
        },
        privacyContext: { status: "completed" },
        patch: { fields: ["outputs"], values: { outputs: { result: "done" } } },
      },
      turnEvidence,
      dependencies: [errorScope],
    });

    const drainResult = await bridge.drain();
    expect(drainResult).toMatchObject({
      status: "drained",
      delivered: 5,
      pending: 0,
      settlement: { turns: [{ status: "settled", patches: 1 }] },
    });

    const settlement = (await createCaptureStore(root).enumerate("claude-code", "session-1")).find(
      ({ record }) => record.eventKind === "run-settlement-patch" && record.runId === CHILD_ID,
    )?.record;
    expect(settlement).toBeDefined();
    expect(settlement?.normalizedPayload).toMatchObject({ privacyContext: { status: "error" } });

    const childPatches = requests.filter(
      ({ method, path }) => method === "PATCH" && path === `/api/v1/runs/${CHILD_ID}`,
    );
    expect(childPatches).toHaveLength(3);
    expect(childPatches[0]?.payload["error"]).toBe("");
    expect(childPatches[1]?.payload["extra"]).toMatchObject({
      metadata: { status: "completed" },
    });
    expect(childPatches[2]?.payload["extra"]).toMatchObject({
      metadata: { status: "error" },
    });
  });

  it("keeps explicit Git attribution across a sparse patch and conflicting sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-settlement-sparse-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-settlement-sparse",
      writer: { destinations: [destination()], redact: false },
    });
    const turnId = "turn-settlement-sparse";
    const children = [CHILD_ID, SIBLING_ID];
    const childRunContext = {
      id: CHILD_ID,
      name: "test run",
      run_type: "tool",
      start_time: "2026-10-10T12:00:00.001Z",
      parent_run_id: PARENT_ID,
      trace_id: PARENT_ID,
      dotted_order: CHILD_DOTTED_ORDER,
    };
    await bridge.capture({
      turnId,
      eventId: "event-root",
      submission: post(PARENT_ID, metadata("claude-code", "root"), {
        start_time: "2026-10-10T12:00:00.000Z",
        trace_id: PARENT_ID,
        dotted_order: PARENT_DOTTED_ORDER,
      }),
      turnEvidence: evidence({
        rootRunId: PARENT_ID,
        childRunIds: children,
        closureState: "authoritative",
      }),
    });
    await bridge.capture({
      turnId,
      eventId: "event-child-post",
      submission: post(
        CHILD_ID,
        { ...metadata("claude-code", "tool"), base: { git_commit_sha: "A" } },
        {
          run_type: "tool",
          start_time: childRunContext.start_time,
          parent_run_id: PARENT_ID,
          trace_id: PARENT_ID,
          dotted_order: CHILD_DOTTED_ORDER,
        },
      ),
      turnEvidence: evidence({ rootRunId: PARENT_ID, childRunIds: children }),
      dependencies: [scope(turnId, "event-root", "session-settlement-sparse")],
    });
    await bridge.capture({
      turnId,
      eventId: "event-child-sparse-patch",
      submission: {
        operation: "patch",
        integration: "claude-code",
        privacyMode: "full",
        metadata: metadata("claude-code", "tool"),
        run: childRunContext,
        privacyContext: { status: "completed" },
        patch: { fields: ["outputs"], values: { outputs: { result: "done" } } },
      },
      turnEvidence: evidence({ rootRunId: PARENT_ID, childRunIds: children }),
      dependencies: [scope(turnId, "event-child-post", "session-settlement-sparse")],
    });
    await bridge.capture({
      turnId,
      eventId: "event-sibling-post",
      submission: post(
        SIBLING_ID,
        {
          ...metadata("claude-code", "tool"),
          base: { repository_name: "acme/project", git_commit_sha: "B" },
        },
        {
          run_type: "tool",
          start_time: "2026-10-10T12:00:00.002Z",
          parent_run_id: PARENT_ID,
          trace_id: PARENT_ID,
          dotted_order: SIBLING_DOTTED_ORDER,
        },
      ),
      turnEvidence: evidence({ rootRunId: PARENT_ID, childRunIds: children }),
      dependencies: [scope(turnId, "event-root", "session-settlement-sparse")],
    });

    await expect(bridge.drain()).resolves.toMatchObject({
      status: "drained",
      delivered: 6,
      pending: 0,
    });
    const childPatches = requests.filter(
      ({ method, path }) => method === "PATCH" && path === `/api/v1/runs/${CHILD_ID}`,
    );
    expect(childPatches).toHaveLength(2);
    expect(childPatches[1]?.payload["extra"]).toMatchObject({
      metadata: { repository_name: "acme/project", git_commit_sha: "A" },
    });
  });

  it("defers captures until native thread identity is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-deferred-"));
    const wake = vi.fn();
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-deferred",
      writer: { destinations: [destination()], redact: false },
      wake,
    });
    const run = post(PARENT_ID, metadata("claude-code", "root"), {
      start_time: "2026-10-10T12:00:00.000Z",
      trace_id: PARENT_ID,
      dotted_order: "20261010T120000000Z11111111-1111-4111-8111-111111111111",
    });
    const capture = {
      turnId: "turn-deferred",
      eventId: "event-deferred",
      submission: run,
      turnEvidence: evidence(),
    };

    await expect(
      bridge.capture({
        ...capture,
        submission: { ...run, metadata: { ...run.metadata, threadId: " " } },
      }),
    ).resolves.toEqual({ status: "deferred", reason: "missing-thread-identity" });
    await expect(
      createCaptureStore(root).enumerate("claude-code", "session-deferred"),
    ).resolves.toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();

    await expect(
      bridge.capture({
        ...capture,
        submission: { ...run, metadata: { ...run.metadata, threadId: "native-thread-42" } },
      }),
    ).resolves.toMatchObject({ status: "published" });
    const record = await createCaptureStore(root).read({
      integration: "claude-code",
      sessionId: "session-deferred",
      turnId: "turn-deferred",
      eventId: "event-deferred",
    });
    expect(record?.metadataProvenance).toMatchObject({ threadId: "native-thread-42" });
    expect(record?.normalizedPayload).toMatchObject({
      run: {
        id: PARENT_ID,
        start_time: "2026-10-10T12:00:00.000Z",
        trace_id: PARENT_ID,
        dotted_order: "20261010T120000000Z11111111-1111-4111-8111-111111111111",
      },
    });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("reuses generated post identity on retry and rejects an unanchored patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-identity-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-retry",
      writer: { destinations: [destination()], redact: false },
    });
    const submission = post(PARENT_ID, metadata("claude-code", "root"));
    const capture = {
      turnId: "turn-retry",
      eventId: "event-retry",
      submission,
      turnEvidence: evidence(),
    };
    const first = await bridge.capture(capture);
    expect(first.status).toBe("published");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const retry = await bridge.capture(capture);
    expect(retry.status).toBe("duplicate");
    if (first.status !== "published" || retry.status !== "duplicate")
      throw new Error("Retry did not reuse capture");
    const firstPayload = first.record.normalizedPayload as unknown as {
      run: Record<string, unknown>;
    };
    const retryPayload = retry.record.normalizedPayload as unknown as {
      run: Record<string, unknown>;
    };
    expect(retryPayload.run["start_time"]).toBe(firstPayload.run["start_time"]);
    expect(retryPayload.run["trace_id"]).toBe(PARENT_ID);
    expect(retryPayload.run["dotted_order"]).toBe(firstPayload.run["dotted_order"]);

    const concurrentCapture = {
      turnId: "turn-concurrent",
      eventId: "event-concurrent",
      submission: post(PARENT_ID, metadata("claude-code", "root")),
      turnEvidence: evidence(),
    };
    let clock = Date.parse("2026-10-10T12:00:00.000Z");
    const advancingClock = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    let concurrentResults: Awaited<ReturnType<typeof bridge.capture>>[];
    try {
      concurrentResults = await Promise.all([
        bridge.capture(concurrentCapture),
        bridge.capture(concurrentCapture),
      ]);
    } finally {
      advancingClock.mockRestore();
    }
    expect(concurrentResults.map(({ status }) => status).toSorted()).toEqual([
      "duplicate",
      "published",
    ]);
    const changedConcurrentCapture = {
      ...concurrentCapture,
      submission: post(PARENT_ID, metadata("claude-code", "root"), {
        inputs: { prompt: "different prompt" },
      }),
    };
    await expect(bridge.capture(changedConcurrentCapture)).resolves.toMatchObject({
      status: "conflict",
    });

    const patch: PreparedRunPatchSubmission = {
      operation: "patch",
      integration: "claude-code",
      privacyMode: "full",
      metadata: metadata("claude-code", "root"),
      run: { id: PARENT_ID, name: "test run", run_type: "chain" },
      privacyContext: { status: "completed" },
      patch: { fields: ["outputs"], values: { outputs: { answer: "done" } } },
    };
    await expect(
      bridge.capture({
        turnId: "turn-other",
        eventId: "event-patch-unanchored",
        submission: patch,
        turnEvidence: evidence(),
      }),
    ).rejects.toThrow("canonical start time");

    const child = post(CHILD_ID, metadata("claude-code", "tool"), {
      run_type: "tool",
      start_time: "2026-10-10T12:00:00.001Z",
      parent_run_id: PARENT_ID,
      dotted_order: CHILD_DOTTED_ORDER,
    });
    await expect(
      bridge.capture({
        turnId: "turn-child",
        eventId: "event-child",
        submission: child,
        turnEvidence: evidence(),
      }),
    ).rejects.toThrow("canonical trace ID and dotted order");
    await expect(
      createCaptureStore(root).enumerate("claude-code", "session-retry"),
    ).resolves.toHaveLength(2);
  });

  it("snapshots privacy and submission data before asynchronous capture work", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-input-snapshot-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
      writer: { destinations: [destination()], redact: false },
    });
    const submission = post(
      PARENT_ID,
      metadata("claude-code", "root"),
      { inputs: { prompt: PRIVATE_MARKER } },
      "metadata",
    );
    Object.defineProperties(submission.run, {
      start_time: { value: undefined, enumerable: true, configurable: true, writable: true },
      parent_run_id: { value: undefined, enumerable: true, configurable: true, writable: true },
      trace_id: { value: undefined, enumerable: true, configurable: true, writable: true },
      dotted_order: { value: undefined, enumerable: true, configurable: true, writable: true },
    });
    const input: LifecycleCaptureInput = {
      turnId: "turn-snapshot",
      eventId: "event-snapshot",
      submission,
      turnEvidence: evidence(),
    };

    const pending = bridge.capture(input);
    submission.privacyMode = "full";
    submission.metadata.threadId = "mutated-thread";
    submission.run.name = "mutated run";
    await expect(pending).resolves.toMatchObject({ status: "published" });

    const record = await createCaptureStore(root).read(scope("turn-snapshot", "event-snapshot"));
    expect(record?.normalizedPayload).toMatchObject({
      privacyMode: "metadata",
      run: { name: "test run" },
    });
    expect(record?.metadataProvenance).toMatchObject({ threadId: "thread-1" });
    expect(JSON.stringify(record)).not.toContain(PRIVATE_MARKER);
  });

  it("snapshots turn evidence and dependencies before asynchronous capture work", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-evidence-snapshot-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
      writer: { destinations: [destination()], redact: false },
    });
    const turnEvidence = evidence({ childRunIds: [CHILD_ID] });
    const dependency: CaptureDependency = scope("turn-prerequisite", "event-prerequisite");
    const dependencies = [dependency];
    const input: LifecycleCaptureInput = {
      turnId: "turn-evidence-snapshot",
      eventId: "event-evidence-snapshot",
      submission: post(PARENT_ID, metadata("claude-code", "root")),
      turnEvidence,
      dependencies,
    };

    const pending = bridge.capture(input);
    turnEvidence.childRunIds[0] = PARENT_ID;
    turnEvidence.closureState = "authoritative";
    dependency.eventId = "mutated-prerequisite";
    dependencies.push(scope("turn-extra", "event-extra"));
    await expect(pending).resolves.toMatchObject({ status: "published" });

    const record = await createCaptureStore(root).read(
      scope("turn-evidence-snapshot", "event-evidence-snapshot"),
    );
    expect(record?.turnEvidence).toEqual({
      childRunIds: [CHILD_ID],
      closureState: "open",
      attributionReady: false,
    });
    expect(record?.dependencies).toEqual([scope("turn-prerequisite", "event-prerequisite")]);
  });

  it("replays reverts through ordered snapshot revisions after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base lifecycle snapshot chain "));
    const sessionId = "session-snapshot-chain";
    const bridgeOptions = {
      storageRoot: root,
      integration: "claude-code" as const,
      sessionId,
      writer: { destinations: [destination()], redact: false },
    };
    const bridge = createLifecycleBridge(bridgeOptions);
    const prerequisite = scope("turn-prerequisite", "event-prerequisite", sessionId);
    const authoritativeSnapshot = (
      eventId: string,
      runOverrides: Partial<PreparedRunPostSubmission["run"]> = {},
      metadataValue: PreparedRunPostSubmission["metadata"] = metadata("claude-code", "root"),
      privacyMode: "full" | "metadata" = "full",
      turnId = "turn-snapshot-chain",
    ) => ({
      ...snapshotInput(eventId, runOverrides, metadataValue, privacyMode, turnId),
      turnEvidence: evidence({ rootRunId: PARENT_ID, closureState: "authoritative" }),
    });
    await bridge.capture({
      turnId: prerequisite.turnId,
      eventId: prerequisite.eventId,
      submission: post(SIBLING_ID, metadata("claude-code", "root")),
      turnEvidence: evidence(),
    });
    const fixedTime = vi.spyOn(Date, "now").mockReturnValue(1_791_633_600_000);
    const restartedBridge = createLifecycleBridge(bridgeOptions);
    let firstResult: LifecycleCaptureResult | undefined;
    let secondResult: LifecycleCaptureResult | undefined;
    let thirdResult: LifecycleCaptureResult | undefined;
    let duplicateResult: LifecycleCaptureResult | undefined;
    try {
      firstResult = await bridge.captureSnapshot({
        ...authoritativeSnapshot(
          "event-snapshot-post",
          { outputs: { answer: "A" } },
          metadata("claude-code", "root"),
          "full",
          "turn-snapshot-chain",
        ),
        dependencies: [prerequisite],
      });
      secondResult = await bridge.captureSnapshot({
        ...authoritativeSnapshot(
          "event-snapshot-b",
          { outputs: { answer: "B" } },
          metadata("claude-code", "root"),
          "full",
          "turn-snapshot-chain",
        ),
        dependencies: [prerequisite],
      });
      thirdResult = await restartedBridge.captureSnapshot(
        authoritativeSnapshot(
          "event-snapshot-revert",
          { outputs: { answer: "A" } },
          metadata("claude-code", "root"),
          "full",
          "turn-snapshot-chain",
        ),
      );
      duplicateResult = await restartedBridge.captureSnapshot(
        authoritativeSnapshot(
          "event-snapshot-retry",
          { outputs: { answer: "A" } },
          metadata("claude-code", "root"),
          "full",
          "turn-snapshot-chain",
        ),
      );
    } finally {
      fixedTime.mockRestore();
    }

    expect(firstResult.status).toBe("published");
    expect(secondResult.status).toBe("published");
    expect(thirdResult.status).toBe("published");
    expect(duplicateResult.status).toBe("duplicate");
    const records = (
      await createCaptureStore(root).enumerateTurn("claude-code", sessionId, "turn-snapshot-chain")
    )
      .map(({ record, capturedAtMs }) => ({ record, capturedAtMs }))
      .filter(({ record }) => record.runId === PARENT_ID)
      .toSorted((left, right) => left.record.eventId.localeCompare(right.record.eventId));
    expect(records).toHaveLength(3);
    expect(records.map(({ capturedAtMs }) => capturedAtMs)).toEqual([
      1_791_633_600_000, 1_791_633_600_000, 1_791_633_600_000,
    ]);
    const postRecord = records.find(
      ({ record }) => record.eventId === "event-snapshot-post",
    )!.record;
    const revisions = records
      .filter(({ record }) => record !== postRecord)
      .map(({ record }) => record);
    const revisionPrefix = `run-snapshot-v1:${createHash("sha256")
      .update(`claude-code\0${sessionId}\0turn-snapshot-chain\0${PARENT_ID}`)
      .digest("hex")}:`;
    expect(revisions.map(({ eventId }) => eventId)).toEqual([
      `${revisionPrefix}000000000001`,
      `${revisionPrefix}000000000002`,
    ]);
    expect(postRecord.dependencies).toEqual([prerequisite]);
    expect(revisions[0]?.dependencies).toEqual([
      scope("turn-snapshot-chain", postRecord.eventId, sessionId),
      prerequisite,
    ]);
    expect(revisions[1]?.dependencies).toEqual([
      scope("turn-snapshot-chain", revisions[0]!.eventId, sessionId),
    ]);

    await expect(restartedBridge.drain()).resolves.toMatchObject({
      status: "drained",
      delivered: 4,
      pending: 0,
    });
    expect(
      requests.map(({ method, payload }) => [method, payload["id"], payload["outputs"]]),
    ).toEqual([
      ["POST", SIBLING_ID, undefined],
      ["POST", PARENT_ID, { answer: "A" }],
      ["PATCH", undefined, { answer: "B" }],
      ["PATCH", undefined, { answer: "A" }],
    ]);
    const compactedPost = await createCaptureStore(root).read(
      scope("turn-snapshot-chain", "event-snapshot-post", sessionId),
    );
    expect(compactedPost).toMatchObject({
      version: 3,
      normalizedPayload: { run: { id: PARENT_ID } },
      compaction: { fields: { inputs: { state: "value" }, outputs: { state: "value" } } },
    });
    await expect(
      restartedBridge.captureSnapshot(
        authoritativeSnapshot("event-snapshot-after-compaction-unchanged", {
          outputs: { answer: "A" },
        }),
      ),
    ).resolves.toMatchObject({ status: "duplicate" });
    const omitted = authoritativeSnapshot("event-snapshot-after-compaction-omitted");
    delete omitted.submission.run.outputs;
    await expect(restartedBridge.captureSnapshot(omitted)).resolves.toMatchObject({
      status: "duplicate",
    });
    await expect(
      restartedBridge.captureSnapshot(
        authoritativeSnapshot("event-snapshot-after-compaction-changed", {
          outputs: { answer: "C" },
        }),
      ),
    ).resolves.toMatchObject({
      status: "published",
      record: {
        normalizedPayload: { patch: { fields: ["outputs"], values: { outputs: { answer: "C" } } } },
      },
    });
    const revisionPath = eventPath(root, {
      integration: "claude-code",
      sessionId,
      turnId: "turn-snapshot-chain",
      eventId: revisions[1]!.eventId,
    });
    const corruptedRevision = JSON.parse(await readFile(revisionPath, "utf8")) as {
      dependencies: CaptureDependency[];
    };
    corruptedRevision.dependencies = [scope("turn-snapshot-chain", postRecord.eventId, sessionId)];
    await writeFile(revisionPath, JSON.stringify(corruptedRevision));
    await expect(
      restartedBridge.captureSnapshot(
        snapshotInput(
          "event-snapshot-invalid-chain",
          { outputs: { answer: "A" } },
          metadata("claude-code", "root"),
          "full",
          "turn-snapshot-chain",
        ),
      ),
    ).resolves.toEqual({ status: "conflict" });
  });

  it("retains omitted optional fields and patches explicit empty collections", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-snapshot-fields-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-snapshot-fields",
      writer: { destinations: [destination()], redact: false },
    });
    const turnId = "turn-snapshot-fields";
    await bridge.captureSnapshot(
      snapshotInput(
        "event-snapshot-fields-post",
        {
          outputs: { answer: "kept" },
          end_time: "2026-10-10T12:00:01.000Z",
          error: "kept error",
          tags: ["kept"],
          serialized: { type: "chain" },
          events: [{ name: "tool", message: "kept" }] as never,
          reference_example_id: "44444444-4444-4444-8444-444444444444",
        },
        metadata("claude-code", "root"),
        "full",
        turnId,
      ),
    );
    await expect(
      bridge.captureSnapshot(
        snapshotInput(
          "event-snapshot-fields-omitted",
          {},
          metadata("claude-code", "root"),
          "full",
          turnId,
        ),
      ),
    ).resolves.toMatchObject({ status: "duplicate" });
    await expect(
      bridge.captureSnapshot(
        snapshotInput(
          "event-snapshot-fields-cleared",
          {
            inputs: {},
            outputs: {},
            tags: [],
            serialized: {},
            events: [],
          },
          metadata("claude-code", "root"),
          "full",
          turnId,
        ),
      ),
    ).resolves.toMatchObject({ status: "published" });

    const revisions = (
      await createCaptureStore(root).enumerateTurn("claude-code", "session-snapshot-fields", turnId)
    )
      .map(({ record }) => record)
      .filter(({ eventKind }) => eventKind === "run-patch");
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.normalizedPayload).toMatchObject({
      patch: {
        fields: ["inputs", "outputs", "tags", "serialized", "events"],
        values: { inputs: {}, outputs: {}, tags: [], serialized: {}, events: [] },
      },
    });
    expect(revisions[0]?.normalizedPayload).not.toMatchObject({
      patch: { values: { end_time: expect.anything(), error: expect.anything() } },
    });
  });

  it("deduplicates concurrent captures of the same latest snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-snapshot-race-"));
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-snapshot-race",
      writer: { destinations: [destination()], redact: false },
    });
    await bridge.captureSnapshot(snapshotInput("event-snapshot-race-post", {}));
    const next = snapshotInput("event-snapshot-race-next", { outputs: { result: "done" } });
    const results = await Promise.all([bridge.captureSnapshot(next), bridge.captureSnapshot(next)]);

    expect(results.map(({ status }) => status).toSorted()).toEqual(["duplicate", "published"]);
    const runCaptures = (
      await createCaptureStore(root).enumerateTurn(
        "claude-code",
        "session-snapshot-race",
        "turn-snapshot",
      )
    ).filter(({ record }) => record.runId === PARENT_ID);
    expect(runCaptures).toHaveLength(2);
  });

  it("retries waking an unchanged snapshot after the saved capture's wake fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-snapshot-wake-retry-"));
    const failure = new Error("injected wake failure");
    let attempts = 0;
    const wake = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw failure;
    });
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-snapshot-wake-retry",
      writer: { destinations: [destination()], redact: false },
      wake,
    });
    const input = snapshotInput("event-snapshot-wake-retry-post", {});

    await expect(bridge.captureSnapshot(input)).rejects.toMatchObject({
      captureResult: { status: "published", record: { eventId: input.eventId } },
      cause: failure,
    });
    await expect(bridge.captureSnapshot(input)).resolves.toMatchObject({ status: "duplicate" });
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("records new dependencies in a revision even when the run snapshot is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-snapshot-dependency-only-"));
    const sessionId = "session-snapshot-dependency-only";
    const turnId = "turn-snapshot-dependency-only";
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      writer: { destinations: [destination()], redact: false },
    });
    const input = snapshotInput(
      "event-snapshot-dependency-only-post",
      {},
      undefined,
      "full",
      turnId,
    );
    await bridge.captureSnapshot(input);

    await expect(
      bridge.captureSnapshot({
        ...input,
        dependencies: [scope(turnId, "event-new-prerequisite", sessionId)],
      }),
    ).resolves.toMatchObject({ status: "published" });
    await expect(
      bridge.captureSnapshot({
        ...input,
        eventId: "event-snapshot-dependency-only-next",
        dependencies: [scope(turnId, "event-next-prerequisite", sessionId)],
      }),
    ).resolves.toMatchObject({ status: "published" });
    await expect(
      createCaptureStore(root).enumerateTurn("claude-code", sessionId, turnId),
    ).resolves.toMatchObject([
      { record: { eventId: input.eventId } },
      {
        record: {
          eventKind: "run-patch",
          dependencies: [
            scope(turnId, input.eventId, sessionId),
            scope(turnId, "event-new-prerequisite", sessionId),
          ],
          normalizedPayload: { patch: { fields: [], values: {} } },
        },
      },
      {
        record: {
          eventKind: "run-patch",
          dependencies: [
            scope(turnId, expect.stringContaining("run-snapshot-v1:"), sessionId),
            scope(turnId, "event-next-prerequisite", sessionId),
          ],
          normalizedPayload: { patch: { fields: [], values: {} } },
        },
      },
    ]);
  });

  it("rejects run identity, privacy, and destination changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-snapshot-reject-"));
    const options = {
      storageRoot: root,
      integration: "claude-code" as const,
      sessionId: "session-snapshot-reject",
      writer: { destinations: [destination()], redact: false },
    };
    const bridge = createLifecycleBridge(options);
    await bridge.captureSnapshot(snapshotInput("event-snapshot-reject-post", {}));

    await expect(
      bridge.captureSnapshot(
        snapshotInput("event-snapshot-identity-change", {
          start_time: "2026-10-10T12:00:00.001Z",
        }),
      ),
    ).rejects.toThrow("Run identity changed");
    await expect(
      bridge.captureSnapshot(
        snapshotInput(
          "event-snapshot-privacy-change",
          {},
          metadata("claude-code", "root"),
          "metadata",
        ),
      ),
    ).resolves.toEqual({ status: "conflict" });
    await expect(
      createLifecycleBridge({
        ...options,
        writer: {
          destinations: [{ ...destination(), projectName: "other-project" }],
          redact: false,
        },
      }).captureSnapshot(snapshotInput("event-snapshot-account-change", {})),
    ).resolves.toEqual({ status: "conflict" });
    await expect(
      createCaptureStore(root).enumerateTurn("claude-code", options.sessionId, "turn-snapshot"),
    ).resolves.toHaveLength(1);
  });

  it("keeps settlement patches outside the snapshot revision head and rejects other patches", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-snapshot-settlement-"));
    const sessionId = "session-snapshot-settlement";
    const turnId = "turn-snapshot-settlement";
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      writer: { destinations: [destination()], redact: false },
    });
    const postResult = await bridge.captureSnapshot(
      snapshotInput(
        "event-snapshot-settlement-post",
        { outputs: { answer: "before" } },
        metadata("claude-code", "root"),
        "full",
        turnId,
      ),
    );
    if (postResult.status !== "published") throw new Error("Snapshot post was not published");
    const store = createCaptureStore(root);
    await store.capture({
      integration: "claude-code",
      sessionId,
      turnId,
      eventId: `turn-settlement-${"a".repeat(64)}`,
      runId: PARENT_ID,
      destinationFingerprint: bridge.accountFingerprint,
      eventKind: "run-settlement-patch",
      normalizedPayload: canonicalJsonValue({
        operation: "patch",
        integration: "claude-code",
        privacyMode: "full",
        metadata: metadata("claude-code", "root"),
        run: {
          id: PARENT_ID,
          name: "test run",
          run_type: "chain",
          start_time: "2026-10-10T12:00:00.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
        },
        privacyContext: { status: "running" },
        patch: { fields: [], values: {} },
      }),
      turnEvidence: { childRunIds: [], closureState: "open" },
      metadataProvenance: canonicalJsonValue(metadata("claude-code", "root")),
      dependencies: [scope(turnId, postResult.record.eventId, sessionId)],
    });

    await expect(
      bridge.captureSnapshot(
        snapshotInput(
          "event-snapshot-after-settlement",
          { outputs: { answer: "after" } },
          metadata("claude-code", "root"),
          "full",
          turnId,
        ),
      ),
    ).resolves.toMatchObject({ status: "published" });
    await expect(
      bridge.captureSnapshot(
        snapshotInput(
          "event-snapshot-after-settlement-again",
          { outputs: { answer: "after again" } },
          metadata("claude-code", "root"),
          "full",
          turnId,
        ),
      ),
    ).resolves.toMatchObject({ status: "published" });
    const patchRecord = (await store.enumerateTurn("claude-code", sessionId, turnId))
      .map(({ record }) => record)
      .find(({ eventKind }) => eventKind === "run-patch");
    expect(patchRecord?.dependencies).toEqual([
      scope(turnId, postResult.record.eventId, sessionId),
    ]);
    await expect(store.enumerateTurn("claude-code", sessionId, turnId)).resolves.toHaveLength(4);

    await store.capture({
      integration: "claude-code",
      sessionId,
      turnId,
      eventId: "foreign-patch",
      runId: PARENT_ID,
      destinationFingerprint: bridge.accountFingerprint,
      eventKind: "run-patch",
      normalizedPayload: { operation: "patch" },
      turnEvidence: { childRunIds: [], closureState: "open" },
      metadataProvenance: {},
    });
    await expect(
      bridge.captureSnapshot(
        snapshotInput(
          "event-snapshot-after-foreign-patch",
          { outputs: { answer: "last" } },
          metadata("claude-code", "root"),
          "full",
          turnId,
        ),
      ),
    ).resolves.toEqual({ status: "conflict" });
  });

  it("rejects snapshot-incompatible settlement redactions and privacy status", async () => {
    const cases = [
      { suffix: "redactions", redactedFields: ["inputs"], status: "running", invalidStatus: false },
      { suffix: "privacy", redactedFields: ["outputs"], status: "pending", invalidStatus: true },
    ] as const;
    for (const testCase of cases) {
      const root = await mkdtemp(join(tmpdir(), `plugins-base-settlement-${testCase.suffix}-`));
      const sessionId = `session-snapshot-settlement-${testCase.suffix}`;
      const turnId = `turn-snapshot-settlement-${testCase.suffix}`;
      const bridge = createLifecycleBridge({
        storageRoot: root,
        integration: "claude-code",
        sessionId,
        writer: { destinations: [destination()], redact: false },
      });
      const input = snapshotInput(
        `event-snapshot-settlement-${testCase.suffix}-post`,
        {},
        metadata("claude-code", "root"),
        "full",
        turnId,
      );
      input.submission = { ...input.submission, redactedFields: ["outputs"] };
      await bridge.captureSnapshot(input);
      await createCaptureStore(root).capture({
        integration: "claude-code",
        sessionId,
        turnId,
        eventId: `turn-settlement-${"b".repeat(64)}`,
        runId: PARENT_ID,
        destinationFingerprint: bridge.accountFingerprint,
        eventKind: "run-settlement-patch",
        normalizedPayload: canonicalJsonValue({
          operation: "patch",
          integration: "claude-code",
          privacyMode: "full",
          redactedFields: testCase.redactedFields,
          run: input.submission.run,
          privacyContext: { status: testCase.status },
          patch: { fields: [], values: {} },
        }),
        turnEvidence: { childRunIds: [], closureState: "open" },
        metadataProvenance: canonicalJsonValue(input.submission.metadata),
        dependencies: [scope(turnId, input.eventId, sessionId)],
      });
      const retry = {
        ...input,
        eventId: `event-snapshot-settlement-${testCase.suffix}-retry`,
        submission: {
          ...input.submission,
          run: { ...input.submission.run, outputs: { answer: "new" } },
        },
      };
      if (testCase.invalidStatus) {
        await expect(bridge.captureSnapshot(retry)).rejects.toThrow("Invalid run privacy status");
      } else {
        await expect(bridge.captureSnapshot(retry)).resolves.toEqual({ status: "conflict" });
      }
    }
  });

  it("snapshots the wake callback when the bridge is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-lifecycle-wake-snapshot-"));
    const initialWake = vi.fn();
    const beforeCaptureWake = vi.fn();
    const afterCaptureWake = vi.fn();
    const options = {
      storageRoot: root,
      integration: "claude-code" as const,
      sessionId: "session-1",
      writer: { destinations: [destination()], redact: false },
      wake: initialWake,
    };
    const bridge = createLifecycleBridge(options);
    options.wake = beforeCaptureWake;
    const pending = bridge.capture({
      turnId: "turn-wake-snapshot",
      eventId: "event-wake-snapshot",
      submission: post(PARENT_ID, metadata("claude-code", "root")),
      turnEvidence: evidence(),
    });
    options.wake = afterCaptureWake;
    await expect(pending).resolves.toMatchObject({ status: "published" });

    expect(initialWake).toHaveBeenCalledTimes(1);
    expect(beforeCaptureWake).not.toHaveBeenCalled();
    expect(afterCaptureWake).not.toHaveBeenCalled();
  });

  it("compacts delivered payloads and supports settlement after 25 hours", async () => {
    const startedAt = Date.parse("2026-10-10T12:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    try {
      const root = await mkdtemp(join(tmpdir(), "plugins-base-retention-25h-proof-"));
      const sessionId = "session-retention-25h";
      const parentTurnId = "turn-retention-parent";
      const childTurnId = "turn-retention-child";
      const bridge = createLifecycleBridge({
        storageRoot: root,
        integration: "claude-code",
        sessionId,
        writer: { destinations: [destination()], redact: false },
      });
      const parentScope = scope(parentTurnId, "event-retention-parent", sessionId);
      const inputs = { prompt: "p".repeat(128_000) };
      const outputs = { answer: "o".repeat(128_000) };
      const parentEvidence = evidence({
        rootRunId: PARENT_ID,
        childRunIds: [CHILD_ID],
        closureState: "authoritative",
      });
      await bridge.capture({
        turnId: parentTurnId,
        eventId: parentScope.eventId,
        submission: post(PARENT_ID, metadata("claude-code", "root"), {
          start_time: "2026-10-10T12:00:00.000Z",
          end_time: "2026-10-10T12:00:01.000Z",
          trace_id: PARENT_ID,
          dotted_order: PARENT_DOTTED_ORDER,
          inputs,
          outputs,
        }),
        turnEvidence: parentEvidence,
      });
      const childPostScope = scope(childTurnId, "event-retention-child-post", sessionId);
      await bridge.capture({
        turnId: childTurnId,
        eventId: childPostScope.eventId,
        submission: post(
          CHILD_ID,
          {
            ...metadata("claude-code", "subagent"),
            base: { repository_name: "acme/project" },
          },
          {
            run_type: "chain",
            start_time: "2026-10-10T12:00:00.100Z",
            end_time: "2026-10-10T12:00:00.900Z",
            parent_run_id: PARENT_ID,
            trace_id: PARENT_ID,
            dotted_order: CHILD_DOTTED_ORDER,
          },
        ),
        turnEvidence: evidence({
          rootRunId: CHILD_ID,
          closureState: "authoritative",
        }),
        dependencies: [parentScope],
      });
      const firstDrain = await bridge.drain();
      expect(firstDrain).toMatchObject({ status: "drained", delivered: 3, pending: 0 });
      expect(firstDrain.settlement.turns).toContainEqual(
        expect.objectContaining({ turnId: parentTurnId, status: "settled" }),
      );

      const store = createCaptureStore(root);
      const destinationId = createLangSmithUploadWriter({
        destinations: [destination()],
        redact: false,
      }).destinations[0]!.id;
      await expect(store.readOutcome(parentScope, destinationId)).resolves.toMatchObject({
        status: "settled",
        receipt: { outcome: "delivered" },
      });

      clock.mockReturnValue(startedAt + 25 * 60 * 60 * 1000);
      await bridge.capture({
        turnId: childTurnId,
        eventId: "event-retention-child-update",
        submission: {
          operation: "patch",
          integration: "claude-code",
          privacyMode: "full",
          metadata: {
            ...metadata("claude-code", "subagent"),
            base: { repository_name: "acme/project", ls_attribution_identifier: "author-1" },
          },
          run: {
            id: CHILD_ID,
            name: "test run",
            run_type: "chain",
            start_time: "2026-10-10T12:00:00.100Z",
            parent_run_id: PARENT_ID,
            trace_id: PARENT_ID,
            dotted_order: CHILD_DOTTED_ORDER,
          },
          privacyContext: { status: "completed" },
          patch: { fields: ["outputs"], values: { outputs: { late: true } } },
        },
        turnEvidence: evidence({
          rootRunId: CHILD_ID,
          closureState: "authoritative",
        }),
        dependencies: [childPostScope],
      });

      const lateDrain = await bridge.drain();
      expect(lateDrain).toMatchObject({ status: "drained", delivered: 2, pending: 0 });
      expect(lateDrain.settlement.turns).toContainEqual(
        expect.objectContaining({ turnId: parentTurnId, status: "settled" }),
      );
      expect(requests.slice(3).map(({ method, path }) => [method, path])).toEqual([
        ["PATCH", `/api/v1/runs/${CHILD_ID}`],
        ["PATCH", `/api/v1/runs/${PARENT_ID}`],
      ]);
      expect(requests[4]?.payload["extra"]).toMatchObject({
        metadata: { repository_name: "acme/project", ls_attribution_identifier: "author-1" },
      });
      expect(requests[4]?.payload["end_time"]).toBe("2026-10-10T12:00:01.000Z");
      const retainedParent = await store.read(parentScope);
      expect(retainedParent).toMatchObject({
        version: 3,
        normalizedPayload: { run: { id: PARENT_ID } },
        compaction: {
          originalContentDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          fields: { inputs: { state: "value" }, outputs: { state: "value" } },
        },
      });
      expect(retainedParent?.normalizedPayload).not.toHaveProperty("run.inputs");
      expect(retainedParent?.normalizedPayload).not.toHaveProperty("run.outputs");
      expect(JSON.stringify(retainedParent)).not.toContain(inputs.prompt);
      expect(JSON.stringify(retainedParent)).not.toContain(outputs.answer);
      await expect(store.readOutcome(parentScope, destinationId)).resolves.toMatchObject({
        status: "settled",
        receipt: { outcome: "delivered" },
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps pending and foreign-account payloads intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-base-retention-pending-"));
    const sessionId = "session-retention-pending";
    const bridge = createLifecycleBridge({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      writer: { destinations: [destination()], redact: false },
    });
    const openScope = scope("turn-retention-open", "event-retention-open", sessionId);
    await capturePost(bridge, openScope, SIBLING_ID, "open input", "open output");
    const pendingScope = scope("turn-retention-pending", "event-retention-pending", sessionId);
    await capturePost(
      bridge,
      pendingScope,
      PARENT_ID,
      "pending input",
      "pending output",
      "authoritative",
    );
    const foreignScope = scope("turn-retention-foreign", "event-retention-foreign", sessionId);
    const store = createCaptureStore(root);
    const foreignBridge = createLifecycleBridge({
      sessionId,
      storageRoot: root,
      integration: "claude-code",
      writer: {
        destinations: [{ ...destination(), apiKey: "synthetic-foreign-key" }],
        redact: false,
      },
    });
    await capturePost(
      foreignBridge,
      foreignScope,
      SIBLING_ID,
      "foreign input",
      "foreign output",
      "authoritative",
    );
    const destinationId = createLangSmithUploadWriter({
      destinations: [destination()],
      redact: false,
    }).destinations[0]!.id;
    await store.recordOutcome({
      ...foreignScope,
      destination: destinationId,
      outcome: "delivered",
    });
    failRequestIndexes = new Set([1]);

    await expect(bridge.drain()).resolves.toMatchObject({
      delivered: 1,
      failed: 1,
      pending: 1,
      accountMismatch: 1,
      settlement: {
        turns: expect.arrayContaining([
          expect.objectContaining({ turnId: openScope.turnId, status: "deferred" }),
          expect.objectContaining({ turnId: pendingScope.turnId, status: "pending" }),
        ]),
      },
    });
    await expect(store.read(openScope)).resolves.toMatchObject({
      version: 2,
      normalizedPayload: {
        run: { inputs: { prompt: "open input" }, outputs: { answer: "open output" } },
      },
    });
    await expect(store.read(pendingScope)).resolves.toMatchObject({
      version: 2,
      normalizedPayload: {
        run: { inputs: { prompt: "pending input" }, outputs: { answer: "pending output" } },
      },
    });
    await expect(store.read(foreignScope)).resolves.toMatchObject({
      version: 2,
      normalizedPayload: { run: { inputs: { prompt: "foreign input" } } },
    });
  });
});
