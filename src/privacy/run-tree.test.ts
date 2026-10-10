import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, type RunTreeConfig } from "langsmith";
import { createSecretAnonymizer } from "langsmith/anonymizer";
import { buildCodingAgentMetadata } from "../metadata/index.js";
import { createCodingAgentRunTree, MUTED_TRACE_CONTENT } from "./index.js";

const PRIVATE_MARKER = "synthetic-private-trace-content";
const PRIVATE_MODEL = "synthetic-private-model";
const REDACTED_MODEL = "[private-model]";
const PRIMARY_KEY = "synthetic-primary-key";
const REPLICA_KEY = "synthetic-replica-key";

let server: ReturnType<typeof createServer>;
let endpoint: string;
let client: Client | undefined;
let requests: Record<string, unknown>[];

function metadata(threadId: string): Record<string, unknown> {
  return buildCodingAgentMetadata({
    integration: "claude-code",
    threadId,
    agentType: "root",
    runType: "root",
    modelName: PRIVATE_MODEL,
    usageMetadata: { input_tokens: 2, output_tokens: 1, provider_note: "kept" },
    base: {
      thread_id: `${PRIVATE_MARKER}_spoofed_thread`,
      repository_name: PRIVATE_MARKER,
      custom: PRIVATE_MARKER,
    },
  });
}

function operations(): Record<string, unknown>[] {
  return requests.flatMap((request) => {
    const method = request["method"] as string;
    const path = request["path"] as string;
    const payload = request["payload"] as Record<string, unknown>;
    if (Array.isArray(payload["post"]) || Array.isArray(payload["patch"])) {
      return [
        ...(payload["post"] as Record<string, unknown>[]).map((item) => ({
          action: "post",
          path,
          payload: item,
        })),
        ...(payload["patch"] as Record<string, unknown>[]).map((item) => ({
          action: "patch",
          path,
          payload: item,
        })),
      ];
    }
    return [{ action: method === "POST" ? "post" : "patch", path, payload }];
  });
}

function makeClient(): Client {
  return new Client({
    apiUrl: endpoint,
    apiKey: PRIMARY_KEY,
    autoBatchTracing: false,
    tracingSamplingRate: 1,
    anonymizer: createSecretAnonymizer({
      extraRules: [{ pattern: PRIVATE_MODEL, replace: REDACTED_MODEL }],
    }),
  });
}

beforeEach(async () => {
  vi.stubEnv("LANGCHAIN_API_KEY", undefined);
  vi.stubEnv("LANGSMITH_API_KEY", undefined);
  vi.stubEnv("LANGSMITH_ENDPOINT", undefined);
  vi.stubEnv("LANGSMITH_RUNS_ENDPOINTS", undefined);
  vi.stubEnv("LANGSMITH_WORKSPACE_ID", "synthetic-workspace-marker");
  vi.stubEnv("LANGCHAIN_REVISION_ID", "synthetic-revision-marker");
  requests = [];
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.url?.endsWith("/info")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ batch_ingest_config: { use_multipart_endpoint: false } }));
        return;
      }
      requests.push({
        method: request.method,
        path: request.url,
        apiKey: request.headers["x-api-key"],
        payload: body.length ? (JSON.parse(body) as Record<string, unknown>) : {},
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local server did not start");
      endpoint = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  try {
    await client?.flush();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    vi.unstubAllEnvs();
  }
});

describe("coding agent metadata privacy at the SDK wire boundary", () => {
  it("filters parent and child posts and keeps later patches private", async () => {
    client = makeClient();
    const parent = createCodingAgentRunTree(
      {
        client,
        name: "parent",
        run_type: "chain",
        inputs: { prompt: PRIVATE_MARKER },
        extra: { metadata: metadata("parent-thread") },
      },
      "claude-code",
      "metadata",
    );
    const child = parent.createChild({
      name: "child",
      run_type: "tool",
      error: "",
      inputs: { command: PRIVATE_MARKER },
      extra: { metadata: metadata("child-thread") },
    });
    child.addEvent({ name: "tool_call", message: PRIVATE_MARKER });
    expect(JSON.stringify(parent.toJSON())).not.toContain(PRIVATE_MARKER);
    child.addEvent({ name: "tool_call", message: PRIVATE_MARKER });
    await parent.postRun(false);
    await child.end({ result: PRIVATE_MARKER }, `${PRIVATE_MARKER}_error`, Date.now(), {
      private_custom: PRIVATE_MARKER,
    });
    await child.patchRun();

    const sent = operations();
    expect(sent).toHaveLength(3);
    const posts = sent.filter((operation) => operation["action"] === "post");
    const patch = sent.find((operation) => operation["action"] === "patch");
    const parentPost = posts.find(
      (operation) => (operation["payload"] as Record<string, unknown>)["name"] === "parent",
    );
    const childPost = posts.find(
      (operation) => (operation["payload"] as Record<string, unknown>)["name"] === "child",
    );
    const childPayload = childPost?.["payload"] as Record<string, unknown>;
    const childExtra = childPayload["extra"] as Record<string, unknown>;
    const childMetadata = childExtra["metadata"] as Record<string, unknown>;
    const childPatch = patch?.["payload"] as Record<string, unknown>;
    const patchMetadata = ((childPatch["extra"] as Record<string, unknown>)["metadata"] ??
      {}) as Record<string, unknown>;
    const serialized = JSON.stringify(sent);

    expect(parentPost).toBeDefined();
    expect(childPayload).toMatchObject({
      parent_run_id: parent.id,
      inputs: { messages: [{ role: "user", content: MUTED_TRACE_CONTENT }] },
      outputs: { messages: [{ role: "assistant", content: MUTED_TRACE_CONTENT }] },
    });
    expect(childMetadata).toMatchObject({
      thread_id: "child-thread",
      ls_model_name: REDACTED_MODEL,
      usage_metadata: { input_tokens: 2, provider_note: "kept" },
      status: "error",
      ls_tracing_mode: "metadata",
    });
    expect(childPatch).toMatchObject({
      inputs: { messages: [{ role: "user", content: MUTED_TRACE_CONTENT }] },
      outputs: { messages: [{ role: "assistant", content: MUTED_TRACE_CONTENT }] },
    });
    expect(patchMetadata).toMatchObject({ status: "error", ls_tracing_mode: "metadata" });
    expect(serialized).not.toContain(PRIVATE_MARKER);
    expect(serialized).not.toContain(PRIVATE_MODEL);
    expect(serialized).toContain(REDACTED_MODEL);
  });

  it.each(["object", "tuple"] as const)(
    "preserves %s replica routing while dropping private updates",
    async (kind) => {
      client = makeClient();
      const updates = {
        inputs: { private: PRIVATE_MARKER },
        outputs: { private: PRIVATE_MARKER },
        error: PRIVATE_MARKER,
        tags: [PRIVATE_MARKER],
        extra: { metadata: { custom: PRIVATE_MARKER }, runtime: { private: PRIVATE_MARKER } },
      };
      const replicas: RunTreeConfig["replicas"] =
        kind === "object"
          ? [
              {
                projectName: "replica",
                apiUrl: `${endpoint}/replica`,
                apiKey: REPLICA_KEY,
                updates,
              },
            ]
          : [["replica", updates]];
      const run = createCodingAgentRunTree(
        {
          client,
          name: "replica-run",
          run_type: "chain",
          inputs: { prompt: PRIVATE_MARKER },
          extra: { metadata: metadata("replica-thread") },
          replicas,
        },
        "claude-code",
        "metadata",
      );
      await run.postRun();
      await run.patchRun();

      expect(requests.length).toBeGreaterThan(0);
      if (kind === "object") {
        expect(requests.every((request) => String(request["path"]).startsWith("/replica/"))).toBe(
          true,
        );
        expect(requests.every((request) => request["apiKey"] === REPLICA_KEY)).toBe(true);
      } else {
        expect(
          requests.every((request) => {
            const path = String(request["path"]);
            return path === "/runs" || path.startsWith("/runs/");
          }),
        ).toBe(true);
        expect(requests.every((request) => request["apiKey"] === PRIMARY_KEY)).toBe(true);
        expect(
          operations().every(
            (operation) =>
              (operation["payload"] as Record<string, unknown>)["session_name"] === "replica",
          ),
        ).toBe(true);
      }
      expect(JSON.stringify(requests)).not.toContain(PRIVATE_MARKER);
    },
  );

  it("keeps Codex metadata only when the shared builder marked it trusted", async () => {
    client = makeClient();
    await createCodingAgentRunTree(
      {
        client,
        name: "untrusted-codex-run",
        run_type: "chain",
        inputs: { prompt: PRIVATE_MARKER },
        extra: { metadata: { thread_id: PRIVATE_MARKER, custom: PRIVATE_MARKER } },
      },
      "openai-codex",
      "metadata",
    ).postRun();
    const trustedRun = createCodingAgentRunTree(
      {
        client,
        name: "trusted-codex-run",
        run_type: "llm",
        inputs: { prompt: PRIVATE_MARKER },
        extra: {
          metadata: buildCodingAgentMetadata({
            integration: "openai-codex",
            threadId: "codex-thread",
            agentType: "root",
            runType: "llm",
            providerMetadata: { ls_provider: "openai" },
          }),
        },
      },
      "openai-codex",
      "metadata",
    );
    await trustedRun.postRun();
    await trustedRun.end({ result: PRIVATE_MARKER }, undefined, Date.now(), {
      thread_id: PRIVATE_MARKER,
      custom: PRIVATE_MARKER,
    });
    await trustedRun.patchRun();

    const sent = operations();
    const untrusted = sent.find(
      (operation) =>
        (operation["payload"] as Record<string, unknown>)["name"] === "untrusted-codex-run",
    );
    const trusted = sent.find(
      (operation) =>
        (operation["payload"] as Record<string, unknown>)["name"] === "trusted-codex-run" &&
        operation["action"] === "post",
    );
    const trustedPatch = sent.find(
      (operation) =>
        (operation["payload"] as Record<string, unknown>)["name"] === "trusted-codex-run" &&
        operation["action"] === "patch",
    );
    const untrustedPayload = (untrusted?.["payload"] ?? {}) as Record<string, unknown>;
    const untrustedExtra = (untrustedPayload["extra"] ?? {}) as Record<string, unknown>;
    const untrustedMetadata = (untrustedExtra["metadata"] ?? {}) as Record<string, unknown>;
    const trustedPayload = (trusted?.["payload"] ?? {}) as Record<string, unknown>;
    const trustedExtra = (trustedPayload["extra"] ?? {}) as Record<string, unknown>;
    const trustedMetadata = (trustedExtra["metadata"] ?? {}) as Record<string, unknown>;
    const trustedPatchPayload = (trustedPatch?.["payload"] ?? {}) as Record<string, unknown>;
    const trustedPatchExtra = (trustedPatchPayload["extra"] ?? {}) as Record<string, unknown>;
    const trustedPatchMetadata = (trustedPatchExtra["metadata"] ?? {}) as Record<string, unknown>;

    expect(untrustedMetadata).toEqual({ status: "running", ls_tracing_mode: "metadata" });
    expect(trustedMetadata).toMatchObject({ thread_id: "codex-thread", ls_provider: "openai" });
    expect(trustedPatchMetadata).toMatchObject({
      thread_id: "codex-thread",
      status: "completed",
      ls_tracing_mode: "metadata",
    });
    expect(JSON.stringify(sent)).not.toContain(PRIVATE_MARKER);
  });

  it("preserves Claude's full-mode patch input default and explicit exclusion", async () => {
    vi.stubEnv("LANGCHAIN_EXCLUDE_INPUTS_ON_PATCH", "true");
    vi.stubEnv("LANGSMITH_EXCLUDE_INPUTS_ON_PATCH", "true");
    client = makeClient();
    const included = createCodingAgentRunTree(
      {
        client,
        name: "full-run-includes-inputs",
        run_type: "chain",
        inputs: { prompt: `${PRIVATE_MARKER}_included` },
      },
      "claude-code",
      "full",
    );
    const excluded = createCodingAgentRunTree(
      {
        client,
        name: "full-run-excludes-inputs",
        run_type: "chain",
        inputs: { prompt: `${PRIVATE_MARKER}_excluded` },
      },
      "claude-code",
      "full",
    );
    const includedChild = included.createChild({
      name: "full-child-includes-inputs",
      run_type: "tool",
      inputs: { command: `${PRIVATE_MARKER}_child_included` },
    });
    const excludedChild = included.createChild({
      name: "full-child-excludes-inputs",
      run_type: "tool",
      inputs: { command: `${PRIVATE_MARKER}_child_excluded` },
    });
    await included.postRun();
    await included.patchRun();
    await includedChild.postRun();
    await includedChild.patchRun();
    await excludedChild.postRun();
    await excludedChild.patchRun({ excludeInputs: true });
    await excluded.postRun();
    await excluded.patchRun({ excludeInputs: true });

    const patches = operations().filter((operation) => operation["action"] === "patch");
    const includedPatch = patches.find(
      (operation) =>
        (operation["payload"] as Record<string, unknown>)["name"] === "full-run-includes-inputs",
    )?.["payload"] as Record<string, unknown>;
    const excludedPatch = patches.find(
      (operation) =>
        (operation["payload"] as Record<string, unknown>)["name"] === "full-run-excludes-inputs",
    )?.["payload"] as Record<string, unknown>;
    const includedChildPatch = patches.find(
      (operation) =>
        (operation["payload"] as Record<string, unknown>)["name"] === "full-child-includes-inputs",
    )?.["payload"] as Record<string, unknown>;
    const excludedChildPatch = patches.find(
      (operation) =>
        (operation["payload"] as Record<string, unknown>)["name"] === "full-child-excludes-inputs",
    )?.["payload"] as Record<string, unknown>;

    expect(includedPatch["inputs"]).toEqual({ prompt: `${PRIVATE_MARKER}_included` });
    expect(excludedPatch).not.toHaveProperty("inputs");
    expect(includedChildPatch["inputs"]).toEqual({
      command: `${PRIVATE_MARKER}_child_included`,
    });
    expect(excludedChildPatch).not.toHaveProperty("inputs");
  });

  it("keeps full and metadata mode separate when they share one client", async () => {
    client = makeClient();
    await createCodingAgentRunTree(
      {
        client,
        name: "full-run",
        run_type: "chain",
        inputs: { prompt: PRIVATE_MARKER },
        extra: { metadata: { custom: PRIVATE_MARKER } },
      },
      "claude-code",
      "full",
    ).postRun();
    await createCodingAgentRunTree(
      {
        client,
        name: "metadata-run",
        run_type: "chain",
        inputs: { prompt: PRIVATE_MARKER },
        extra: { metadata: metadata("metadata-thread") },
      },
      "claude-code",
      "metadata",
    ).postRun();

    const sent = operations();
    const full = sent.find(
      (operation) => (operation["payload"] as Record<string, unknown>)["name"] === "full-run",
    );
    const privateRun = sent.find(
      (operation) => (operation["payload"] as Record<string, unknown>)["name"] === "metadata-run",
    );
    const fullPayload = full?.["payload"] as Record<string, unknown>;
    const privatePayload = privateRun?.["payload"] as Record<string, unknown>;

    expect(fullPayload["inputs"]).toEqual({ prompt: PRIVATE_MARKER });
    expect(
      ((fullPayload["extra"] as Record<string, unknown>)["metadata"] as Record<string, unknown>)[
        "custom"
      ],
    ).toBe(PRIVATE_MARKER);
    expect(privatePayload["inputs"]).toEqual({
      messages: [{ role: "user", content: MUTED_TRACE_CONTENT }],
    });
    expect(JSON.stringify(privatePayload)).not.toContain(PRIVATE_MARKER);
  });
});
