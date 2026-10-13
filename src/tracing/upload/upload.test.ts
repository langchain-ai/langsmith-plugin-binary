import type { LocalRequest } from "../../test-support/models/upload.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodingAgentMetadataOptions } from "../../metadata/index.js";
import { createLangSmithUploadWriter } from "./index.js";
import { resolveUploadDestinationFingerprint } from "./identity.js";
import type {
  LangSmithUploadDestinationConfig,
  PreparedRunPostSubmission,
  UploadDestination,
} from "./models.js";

const PRIMARY_KEY = "synthetic-primary-key";
const REPLICA_KEY = "synthetic-replica-key";
const FAILING_KEY = "synthetic-failing-key";
const PRIVATE_MARKER = "synthetic-private-upload-marker";
const RUN_ID = "12345678-1234-4123-8123-123456789012";

let server: ReturnType<typeof createServer>;
let endpoint: string;
let requests: LocalRequest[];
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

function destinationByIndex(destinations: readonly UploadDestination[], index: number): string {
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
    const payload = body.length === 0 ? {} : (JSON.parse(body) as Record<string, unknown>);
    const apiKey = headerValue(request.headers["x-api-key"]) ?? "";
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      apiKey,
      workspaceId: headerValue(request.headers["x-tenant-id"]),
      payload,
    });
    if (request.method === "POST" && typeof payload["id"] === "string") {
      storedRuns.set(apiKey + ":" + payload["id"], payload);
    } else if (request.method === "PATCH") {
      const runId = decodeURIComponent((request.url ?? "").split("/").at(-1) ?? "");
      const key = apiKey + ":" + runId;
      const previous = storedRuns.get(key);
      if (previous) storedRuns.set(key, { ...previous, ...payload });
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

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

beforeEach(async () => {
  requests = [];
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
