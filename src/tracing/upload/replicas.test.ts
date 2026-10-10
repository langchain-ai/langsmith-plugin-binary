import type { LocalRequest } from "../../test-support/models/upload.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { computeRunIdForSecondaryReplica } from "langsmith";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodingAgentMetadataOptions } from "../../metadata/index.js";
import { createLangSmithUploadWriter } from "./index.js";
import { resolveUploadDestinationFingerprint } from "./identity.js";
import type {
  LangSmithUploadDestinationConfig,
  LangSmithUploadReplicaConfig,
  PreparedRunPatchSubmission,
  PreparedRunPostSubmission,
  UploadDestination,
} from "./models.js";

const PRIMARY_KEY = "synthetic-replica-primary-key";
const REPLICA_KEY = "synthetic-replica-secondary-key";
const PRIVATE_MARKER = "synthetic-replica-private-marker";
const REDACTED_MARKER = `${PRIVATE_MARKER}_redacted`;
const ROOT_V7_ID = "018f4c2a-0000-7000-8000-000000000001";
const CHILD_V7_ID = "018f4c2a-0000-7000-8000-000000000002";
const ROOT_V5_ID = "123e4567-e89b-52d3-a456-426614174000";
const CHILD_V5_ID = "123e4567-e89b-52d3-a456-426614174001";
const ROOT_ORDER_PREFIX = "20250101T000000000Z";
const CHILD_ORDER_PREFIX = "20250101T000001000Z";
const PROTECTED_UPDATE_FIELDS = [
  "id",
  "name",
  "run_type",
  "start_time",
  "parent_run_id",
  "session_id",
  "session_name",
  "trace_id",
  "dotted_order",
] as const;

let server: ReturnType<typeof createServer>;
let endpoint: string;
let requests: LocalRequest[];
let storedRuns: Map<string, Record<string, unknown>>;

function destination(
  apiKey: string,
  projectName: string,
  workspaceId = "synthetic-replica-workspace",
): LangSmithUploadDestinationConfig {
  return { apiKey, apiUrl: endpoint, projectName, workspaceId };
}

function metadata(): CodingAgentMetadataOptions {
  return {
    integration: "openai-codex",
    threadId: "replica-thread",
    turnId: "replica-turn",
    agentType: "root",
    runType: "root",
  };
}

function segment(id: string, child: boolean): string {
  return `${child ? CHILD_ORDER_PREFIX : ROOT_ORDER_PREFIX}${id}`;
}

function postSubmission(id: string, parentId?: string): PreparedRunPostSubmission {
  return {
    operation: "post",
    integration: "openai-codex",
    privacyMode: "full",
    metadata: metadata(),
    run: {
      id,
      name: parentId === undefined ? "root" : "child",
      run_type: parentId === undefined ? "chain" : "tool",
      start_time: parentId === undefined ? "2025-01-01T00:00:00Z" : "2025-01-01T00:00:01Z",
      inputs: { prompt: parentId === undefined ? "root input" : "child input" },
      ...(parentId === undefined
        ? { trace_id: id, dotted_order: segment(id, false) }
        : {
            parent_run_id: parentId,
            trace_id: parentId,
            dotted_order: `${segment(parentId, false)}.${segment(id, true)}`,
          }),
    },
  };
}

function patchSubmission(
  id: string,
  parentId?: string,
  overrides: Partial<PreparedRunPatchSubmission> = {},
): PreparedRunPatchSubmission {
  return {
    operation: "patch",
    integration: "openai-codex",
    privacyMode: "full",
    metadata: metadata(),
    privacyContext: { status: "completed" },
    run: {
      id,
      name: parentId === undefined ? "root" : "child",
      run_type: parentId === undefined ? "chain" : "tool",
      start_time: parentId === undefined ? "2025-01-01T00:00:00Z" : "2025-01-01T00:00:01Z",
      ...(parentId === undefined
        ? { trace_id: id, dotted_order: segment(id, false) }
        : {
            parent_run_id: parentId,
            trace_id: parentId,
            dotted_order: `${segment(parentId, false)}.${segment(id, true)}`,
          }),
    },
    patch: { fields: ["outputs"], values: { outputs: { result: "updated" } } },
    ...overrides,
  };
}

function destinationId(destinations: readonly UploadDestination[]): string {
  const resolved = destinations[0];
  if (!resolved) throw new Error("Missing upload destination");
  return resolved.id;
}

function recordRequest(request: IncomingMessage, response: ServerResponse): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    const payload = body.length === 0 ? {} : (JSON.parse(body) as Record<string, unknown>);
    const apiKey = headerValue(request.headers["x-api-key"]);
    requests.push({
      method: request.method ?? "",
      path: request.url ?? "",
      apiKey,
      workspaceId: headerValue(request.headers["x-tenant-id"]),
      payload,
    });
    if (request.method === "POST" && typeof payload["id"] === "string") {
      storedRuns.set(`${apiKey}:${payload["id"]}`, payload);
    } else if (request.method === "PATCH") {
      const runId = decodeURIComponent((request.url ?? "").split("/").at(-1) ?? "");
      const key = `${apiKey}:${runId}`;
      const previous = storedRuns.get(key);
      if (previous) storedRuns.set(key, { ...previous, ...payload });
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function replicaWriter(
  replicas: readonly LangSmithUploadReplicaConfig[],
  redact = false,
  redactExtraRules?: readonly { pattern: string; replace?: string }[],
) {
  return createLangSmithUploadWriter({
    destinations: [destination(PRIMARY_KEY, "primary-project")],
    replicas,
    redact,
    ...(redactExtraRules === undefined ? {} : { redactExtraRules }),
  });
}

async function sendTree(
  writer: ReturnType<typeof createLangSmithUploadWriter>,
  rootId: string,
  childId: string,
): Promise<void> {
  const id = destinationId(writer.destinations);
  await writer.send(postSubmission(rootId), id);
  await writer.send(postSubmission(childId, rootId), id);
  await writer.send(patchSubmission(rootId), id);
  await writer.send(patchSubmission(childId, rootId), id);
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

describe("shared replica routing", () => {
  it("inherits omitted replica connection and project fields from the primary", async () => {
    const writer = replicaWriter([{}]);

    await writer.send(postSubmission(ROOT_V7_ID), destinationId(writer.destinations));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      apiKey: PRIMARY_KEY,
      workspaceId: "synthetic-replica-workspace",
      payload: { id: ROOT_V7_ID, session_name: "primary-project" },
    });
  });

  it.each([
    { name: "primary only", apiKey: PRIMARY_KEY, projectName: "primary-project" },
    { name: "same-project replica", apiKey: REPLICA_KEY, projectName: "primary-project" },
    { name: "distinct-project replica", apiKey: REPLICA_KEY, projectName: "replica-project" },
  ])("routes root and child POST/PATCH correctly for $name", async (scenario) => {
    const configuredReplicas =
      scenario.apiKey === PRIMARY_KEY
        ? undefined
        : [{ apiKey: scenario.apiKey, projectName: scenario.projectName }];
    const writer = configuredReplicas
      ? replicaWriter(configuredReplicas)
      : createLangSmithUploadWriter({
          destinations: [destination(PRIMARY_KEY, "primary-project")],
          redact: false,
        });
    const mappedRoot =
      scenario.projectName === "replica-project"
        ? computeRunIdForSecondaryReplica(ROOT_V7_ID, scenario.projectName)
        : ROOT_V7_ID;
    const mappedChild =
      scenario.projectName === "replica-project"
        ? computeRunIdForSecondaryReplica(CHILD_V7_ID, scenario.projectName)
        : CHILD_V7_ID;

    await sendTree(writer, ROOT_V7_ID, CHILD_V7_ID);

    expect(requests.map(({ method, apiKey }) => [method, apiKey])).toEqual([
      ["POST", scenario.apiKey],
      ["POST", scenario.apiKey],
      ["PATCH", scenario.apiKey],
      ["PATCH", scenario.apiKey],
    ]);
    expect(requests.every(({ workspaceId }) => workspaceId === "synthetic-replica-workspace")).toBe(
      true,
    );
    expect(requests.filter(({ method }) => method === "PATCH").map(({ path }) => path)).toEqual([
      `/api/v1/runs/${mappedRoot}`,
      `/api/v1/runs/${mappedChild}`,
    ]);
    const root = storedRuns.get(`${scenario.apiKey}:${mappedRoot}`);
    const child = storedRuns.get(`${scenario.apiKey}:${mappedChild}`);
    expect(root).toMatchObject({
      id: mappedRoot,
      trace_id: mappedRoot,
      dotted_order: segment(mappedRoot, false),
    });
    expect(child).toMatchObject({
      id: mappedChild,
      parent_run_id: mappedRoot,
      trace_id: mappedRoot,
      dotted_order: `${segment(mappedRoot, false)}.${segment(mappedChild, true)}`,
    });
    if (configuredReplicas)
      expect(requests.every(({ apiKey }) => apiKey !== PRIMARY_KEY)).toBe(true);
  });

  it("keeps non-v7 replica IDs and their parent links stable across retries and writer recreation", async () => {
    const first = replicaWriter([{ apiKey: REPLICA_KEY, projectName: "replica-project" }]);
    const firstDestinationId = destinationId(first.destinations);
    await sendTree(first, ROOT_V5_ID, CHILD_V5_ID);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = replicaWriter([{ apiKey: REPLICA_KEY, projectName: "replica-project" }]);
    expect(second.accountFingerprint).toBe(first.accountFingerprint);
    expect(destinationId(second.destinations)).toBe(firstDestinationId);
    await sendTree(second, ROOT_V5_ID, CHILD_V5_ID);

    const rootPosts = requests.filter(
      ({ method, payload }) => method === "POST" && payload["name"] === "root",
    );
    const childPosts = requests.filter(
      ({ method, payload }) => method === "POST" && payload["name"] === "child",
    );
    const rootId = rootPosts[0]?.payload["id"];
    const childId = childPosts[0]?.payload["id"];
    expect(rootPosts).toHaveLength(2);
    expect(childPosts).toHaveLength(2);
    expect(typeof rootId).toBe("string");
    expect(typeof childId).toBe("string");
    expect(rootPosts.map(({ payload }) => payload["id"])).toEqual([rootId, rootId]);
    expect(childPosts.map(({ payload }) => payload["id"])).toEqual([childId, childId]);
    expect(childPosts.map(({ payload }) => payload["parent_run_id"])).toEqual([rootId, rootId]);
    expect(childPosts.map(({ payload }) => payload["trace_id"])).toEqual([rootId, rootId]);
    expect(String(rootId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(rootId)[14]).toBe("5");
    expect(String(childId)[14]).toBe("5");
    expect(requests.filter(({ method }) => method === "PATCH").map(({ path }) => path)).toEqual([
      `/api/v1/runs/${rootId}`,
      `/api/v1/runs/${childId}`,
      `/api/v1/runs/${rootId}`,
      `/api/v1/runs/${childId}`,
    ]);
    expect(storedRuns.get(`${REPLICA_KEY}:${childId}`)).toMatchObject({
      parent_run_id: rootId,
      trace_id: rootId,
      dotted_order: `${segment(String(rootId), false)}.${segment(String(childId), true)}`,
    });
  });

  it("applies full-mode updates without replacing shared metadata and drops them in metadata mode", async () => {
    const updates = {
      inputs: { prompt: `${PRIVATE_MARKER}_replica_input` },
      outputs: { answer: `${PRIVATE_MARKER}_replica_output` },
      error: `${PRIVATE_MARKER}_replica_error`,
      tags: [`${PRIVATE_MARKER}_replica_tag`],
      extra: {
        metadata: { ls_integration: "cursor", custom: `${PRIVATE_MARKER}_replica_metadata` },
        runtime: { custom: "replica runtime update" },
      },
    };
    const writer = replicaWriter(
      [{ apiKey: REPLICA_KEY, projectName: "replica-project", updates }],
      true,
      [{ pattern: PRIVATE_MARKER, replace: REDACTED_MARKER }],
    );
    const id = destinationId(writer.destinations);
    const fullPatch = patchSubmission(ROOT_V7_ID, undefined, {
      privacyMode: "full",
      patch: {
        fields: ["inputs", "outputs"],
        values: { inputs: { prompt: "source input" }, outputs: { answer: "source output" } },
      },
    });
    await writer.send(fullPatch, id);
    const fullPayload = requests[0]?.payload;
    expect(fullPayload).toMatchObject({
      inputs: { prompt: "source input" },
      outputs: { answer: `${REDACTED_MARKER}_replica_output` },
      error: `${REDACTED_MARKER}_replica_error`,
      tags: [`${REDACTED_MARKER}_replica_tag`],
      extra: {
        metadata: {
          ls_integration: "openai-codex",
          thread_id: "replica-thread",
          custom: `${REDACTED_MARKER}_replica_metadata`,
        },
        runtime: { custom: "replica runtime update" },
      },
    });

    await writer.send(
      patchSubmission(ROOT_V7_ID, undefined, {
        privacyMode: "metadata",
        privacyContext: { status: "completed" },
      }),
      id,
    );
    const metadataPayload = requests[1]?.payload;
    expect(metadataPayload).toMatchObject({
      outputs: { messages: [{ role: "assistant" }] },
      extra: { metadata: { ls_integration: "openai-codex", status: "completed" } },
    });
    expect(JSON.stringify(metadataPayload)).not.toContain(PRIVATE_MARKER);
    expect(metadataPayload).not.toHaveProperty("error");
    expect(metadataPayload).not.toHaveProperty("tags");
  });

  it("redacts only fresh fields while still protecting replica output overrides", async () => {
    const writer = replicaWriter([{ projectName: "replica-project" }], true, [
      { pattern: PRIVATE_MARKER, replace: REDACTED_MARKER },
    ]);
    const id = destinationId(writer.destinations);
    const original = postSubmission(ROOT_V7_ID);
    await writer.send(
      {
        ...original,
        redactedFields: ["inputs"],
        metadata: { ...metadata(), base: { custom: PRIVATE_MARKER } },
        run: {
          ...original.run,
          inputs: { value: REDACTED_MARKER },
          outputs: { value: PRIVATE_MARKER },
          error: PRIVATE_MARKER,
          tags: [PRIVATE_MARKER],
        },
      },
      id,
    );
    expect(requests[0]?.payload).toMatchObject({
      inputs: { value: REDACTED_MARKER },
      outputs: { value: REDACTED_MARKER },
      error: REDACTED_MARKER,
      tags: [REDACTED_MARKER],
      extra: { metadata: { custom: REDACTED_MARKER } },
    });
    const prepared = patchSubmission(ROOT_V7_ID, undefined, {
      redactedFields: ["outputs"],
      patch: {
        fields: ["inputs", "outputs"],
        values: { inputs: { value: PRIVATE_MARKER }, outputs: { value: REDACTED_MARKER } },
      },
    });
    await writer.send(prepared, id);
    expect(requests[1]?.payload).toMatchObject({
      inputs: { value: REDACTED_MARKER },
      outputs: { value: REDACTED_MARKER },
    });
    const replica = replicaWriter(
      [{ projectName: "replica-project", updates: { outputs: { value: PRIVATE_MARKER } } }],
      true,
      [{ pattern: PRIVATE_MARKER, replace: REDACTED_MARKER }],
    );
    await replica.send(prepared, destinationId(replica.destinations));
    expect(requests[2]?.payload).toMatchObject({ outputs: { value: REDACTED_MARKER } });
    await replica.send(
      {
        ...original,
        redactedFields: ["outputs"],
        run: { ...original.run, outputs: { value: REDACTED_MARKER } },
      },
      destinationId(replica.destinations),
    );
    expect(requests[3]?.payload).toMatchObject({ outputs: { value: REDACTED_MARKER } });
  });

  it("rejects unsupported and repeated redacted fields before upload", async () => {
    const writer = replicaWriter([{ projectName: "replica-project" }]);
    for (const redactedFields of [null, ["metadata"], ["inputs", "inputs"]]) {
      await expect(
        writer.send(
          { ...postSubmission(ROOT_V7_ID), redactedFields } as unknown as PreparedRunPostSubmission,
          destinationId(writer.destinations),
        ),
      ).rejects.toThrow("Redacted fields must be unique inputs or outputs");
    }
    expect(requests).toHaveLength(0);
  });

  it("keeps withheld end times out of replica updates", async () => {
    const endTime = "2025-01-01T00:01:00Z";
    const writer = replicaWriter([
      { projectName: "replica-project", updates: { end_time: endTime } },
    ]);
    const id = destinationId(writer.destinations);
    await writer.send(
      patchSubmission(ROOT_V7_ID, undefined, { patch: { fields: [], values: {} } }),
      id,
    );
    expect(requests[0]?.payload).not.toHaveProperty("end_time");
    await writer.send(
      patchSubmission(ROOT_V7_ID, undefined, {
        patch: { fields: ["end_time"], values: { end_time: endTime } },
      }),
      id,
    );
    expect(requests[1]?.payload).toHaveProperty("end_time", endTime);
  });

  it("applies replica errors while preserving the generated error status", async () => {
    const writer = replicaWriter([
      {
        apiKey: REPLICA_KEY,
        projectName: "replica-project",
        updates: { error: "replica-specific error", extra: { metadata: { status: "completed" } } },
      },
    ]);
    await writer.send(
      patchSubmission(ROOT_V7_ID, undefined, {
        metadata: { ...metadata(), base: { status: "error" } },
        privacyContext: { status: "error" },
      }),
      destinationId(writer.destinations),
    );

    expect(requests[0]?.payload).toMatchObject({
      error: "replica-specific error",
      extra: { metadata: { status: "error" } },
    });
  });

  it.each(PROTECTED_UPDATE_FIELDS)("rejects replica updates that override %s", (field) => {
    const updates = { [field]: "synthetic-invalid-identity" };
    expect(() =>
      replicaWriter([{ apiKey: REPLICA_KEY, projectName: "replica-project", updates }]),
    ).toThrow("Replica updates cannot override run identity");
  });

  it.each([{ result: null }, { result: [] }])(
    "rejects replica updates that serialize to a non-object: $result",
    ({ result }) => {
      const updates = { toJSON: () => result };
      expect(() =>
        replicaWriter([{ apiKey: REPLICA_KEY, projectName: "replica-project", updates }]),
      ).toThrow("Replica updates must be an object");
    },
  );

  it("binds updates into the account identity and snapshots their values", async () => {
    const updates: Record<string, unknown> = {
      outputs: { answer: "original replica update", detail: "stable" },
    };
    const firstOptions = {
      destinations: [destination(PRIMARY_KEY, "primary-project")],
      replicas: [{ apiKey: REPLICA_KEY, projectName: "replica-project", updates }],
      redact: false,
    };
    const first = createLangSmithUploadWriter(firstOptions);
    const firstIdentityFingerprint = resolveUploadDestinationFingerprint(firstOptions);
    updates["outputs"] = { answer: "mutated after writer creation" };
    const sameOptions = {
      destinations: [destination(PRIMARY_KEY, "primary-project")],
      replicas: [
        {
          apiKey: REPLICA_KEY,
          projectName: "replica-project",
          updates: { outputs: { detail: "stable", answer: "original replica update" } },
        },
      ],
      redact: false,
    };
    const same = createLangSmithUploadWriter(sameOptions);
    const changedOptions = {
      destinations: [destination(PRIMARY_KEY, "primary-project")],
      replicas: [
        {
          apiKey: REPLICA_KEY,
          projectName: "replica-project",
          updates: { outputs: { answer: "different replica update" } },
        },
      ],
      redact: false,
    };
    const changed = createLangSmithUploadWriter(changedOptions);

    expect(first.accountFingerprint).toBe(same.accountFingerprint);
    expect(firstIdentityFingerprint).toBe(first.accountFingerprint);
    expect(resolveUploadDestinationFingerprint(sameOptions)).toBe(same.accountFingerprint);
    expect(resolveUploadDestinationFingerprint(changedOptions)).toBe(changed.accountFingerprint);
    expect(first.accountFingerprint).not.toBe(changed.accountFingerprint);
    expect(destinationId(first.destinations)).toBe(destinationId(same.destinations));
    expect(destinationId(first.destinations)).not.toBe(destinationId(changed.destinations));
    await first.send(patchSubmission(ROOT_V7_ID), destinationId(first.destinations));
    expect(requests[0]?.payload["outputs"]).toEqual({
      answer: "original replica update",
      detail: "stable",
    });
  });
});
