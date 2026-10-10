import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { CaptureScope } from "../../storage/capture/models.js";
import { MUTED_TRACE_CONTENT } from "../../privacy/index.js";
import type {
  LangSmithUploadDestinationConfig,
  PreparedRunPatchSubmission,
  PreparedRunPostSubmission,
} from "../upload/models.js";
import type { LocalRequest } from "../../test-support/models/lifecycle.js";
import { createLifecycleBridge } from "./index.js";
import type { LifecycleTurnEvidence } from "./models.js";

const PRIVATE_MARKER = "lifecycle-private-content-marker";
const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_DOTTED_ORDER = `20261010T120000000000Z${PARENT_ID}`;
const CHILD_DOTTED_ORDER = `${PARENT_DOTTED_ORDER}.20261010T120000001000Z${CHILD_ID}`;

let server: ReturnType<typeof createServer>;
let endpoint: string;
let requests: LocalRequest[];

function requestBody(request: IncomingMessage, response: ServerResponse): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      payload: body === "" ? {} : (JSON.parse(body) as Record<string, unknown>),
    });
    response.writeHead(200, { "content-type": "application/json" });
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

function scope(turnId: string, eventId: string): CaptureScope {
  return { integration: "claude-code", sessionId: "session-1", turnId, eventId };
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

describe("durable run lifecycle bridge", () => {
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
    expect(record.turnEvidence).toEqual({ childRunIds: [], closureState: "provisional" });
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
});
