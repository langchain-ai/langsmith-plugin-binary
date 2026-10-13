import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settlementHooks = vi.hoisted(() => ({
  eventKind: "run-settlement-patch",
  beforeFirstCapture: null as null | (() => Promise<void>),
}));

vi.mock("../delivery/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../delivery/index.js")>();
  return {
    ...actual,
    createDeliveryCoordinator: vi.fn((options) => {
      const coordinator = actual.createDeliveryCoordinator(options);
      return {
        ...coordinator,
        async capture(input: DeliveryCaptureInput) {
          if (
            input.eventKind === settlementHooks.eventKind &&
            settlementHooks.beforeFirstCapture !== null
          ) {
            const beforeFirstCapture = settlementHooks.beforeFirstCapture;
            settlementHooks.beforeFirstCapture = null;
            await beforeFirstCapture();
          }
          return coordinator.capture(input);
        },
      };
    }),
  };
});

import { createLifecycleBridge } from "./index.js";
import type { DeliveryCaptureInput } from "../delivery/models.js";
import type { LifecycleBridge, LifecycleDrainResult, LifecycleTurnEvidence } from "./models.js";
import type { PreparedRunPatchSubmission, PreparedRunPostSubmission } from "../upload/models.js";
import type { LocalRequest } from "../../test-support/models/lifecycle.js";

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const ROOT_ORDER = `20261010T120000000000Z${ROOT_ID}`;
const CHILD_ORDER = `${ROOT_ORDER}.20261010T120000001000Z${CHILD_ID}`;
const REPOSITORY = {
  repository_name: "acme/project",
  repository_provider: "github",
  repository_url: "https://github.com/acme/project",
  git_branch: "main",
  git_commit_sha: "abc123",
};

let server: ReturnType<typeof createServer>;
let endpoint: string;
let requests: LocalRequest[];
let storedRuns: Map<string, Record<string, unknown>>;
let storageRoot: string;

function respond(request: IncomingMessage, response: ServerResponse): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    const payload = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
    const method = request.method ?? "";
    const path = request.url ?? "";
    requests.push({ method, path, payload });
    if (method === "POST" && typeof payload["id"] === "string") {
      storedRuns.set(payload["id"] as string, payload);
    } else if (method === "PATCH") {
      const runId = decodeURIComponent(path.split("/").at(-1) ?? "");
      const previous = storedRuns.get(runId);
      if (previous) storedRuns.set(runId, { ...previous, ...payload });
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
}

function metadata(runType: "root" | "tool", branch?: string) {
  return {
    integration: "claude-code" as const,
    threadId: "thread-1",
    agentType: runType === "root" ? ("root" as const) : ("subagent" as const),
    runType,
    ...(branch === undefined ? {} : { base: { ...REPOSITORY, git_branch: branch } }),
  };
}

function post(id: string, runType: "root" | "tool", branch?: string): PreparedRunPostSubmission {
  const root = runType === "root";
  return {
    operation: "post",
    integration: "claude-code",
    privacyMode: "full",
    metadata: metadata(runType, branch),
    run: {
      id,
      name: `${runType} run`,
      run_type: root ? "chain" : "tool",
      start_time: root ? "2026-10-10T12:00:00.000Z" : "2026-10-10T12:00:00.001Z",
      end_time: root ? "2026-10-10T12:00:01.000Z" : "2026-10-10T12:00:02.000Z",
      inputs: {},
      ...(root
        ? { trace_id: ROOT_ID, dotted_order: ROOT_ORDER }
        : { parent_run_id: ROOT_ID, trace_id: ROOT_ID, dotted_order: CHILD_ORDER }),
    },
  };
}

function rootPatch(branch: string): PreparedRunPatchSubmission {
  return {
    operation: "patch",
    integration: "claude-code",
    privacyMode: "full",
    metadata: metadata("root", branch),
    run: {
      id: ROOT_ID,
      name: "root run",
      run_type: "chain",
      start_time: "2026-10-10T12:00:00.000Z",
      trace_id: ROOT_ID,
      dotted_order: ROOT_ORDER,
    },
    privacyContext: { status: "completed" },
    patch: { fields: [], values: {} },
  };
}

function evidence(): LifecycleTurnEvidence {
  return { rootRunId: ROOT_ID, childRunIds: [CHILD_ID], closureState: "authoritative" };
}

beforeEach(async () => {
  requests = [];
  storedRuns = new Map();
  server = createServer(respond);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local endpoint did not start");
      endpoint = `http://127.0.0.1:${address.port}/api/v1`;
      resolve();
    });
  });
  storageRoot = await mkdtemp(join(tmpdir(), "plugins-base-settlement-race-"));
});

afterEach(async () => {
  settlementHooks.beforeFirstCapture = null;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("lifecycle settlement drain ordering", () => {
  it("keeps a stale settlement pass from landing after a newer source revision", async () => {
    let announceOldCapture!: () => void;
    let releaseOldCapture!: () => void;
    const oldCaptureEntered = new Promise<void>((resolve) => {
      announceOldCapture = resolve;
    });
    const oldCaptureGate = new Promise<void>((resolve) => {
      releaseOldCapture = resolve;
    });
    settlementHooks.beforeFirstCapture = async () => {
      announceOldCapture();
      await oldCaptureGate;
    };

    const sessionId = "session-settlement-race";
    const turnId = "turn-settlement-race";
    const rootScope = {
      integration: "claude-code",
      sessionId,
      turnId,
      eventId: "event-root",
    };
    const writer = {
      destinations: [{ apiKey: "synthetic-race-key", apiUrl: endpoint, projectName: "race" }],
      redact: false,
    };
    const bridge = createLifecycleBridge({
      storageRoot,
      integration: "claude-code",
      sessionId,
      writer,
    });
    const concurrentBridge = createLifecycleBridge({
      storageRoot,
      integration: "claude-code",
      sessionId,
      writer,
    });
    await bridge.capture({
      turnId,
      eventId: rootScope.eventId,
      submission: post(ROOT_ID, "root", "main"),
      turnEvidence: evidence(),
    });
    await bridge.capture({
      turnId,
      eventId: "event-child",
      submission: post(CHILD_ID, "tool"),
      turnEvidence: evidence(),
      dependencies: [rootScope],
    });

    let firstDrain: ReturnType<typeof bridge.drain> | undefined;
    let concurrentDrain: ReturnType<typeof bridge.drain> | undefined;
    try {
      firstDrain = bridge.drain();
      await oldCaptureEntered;
      await concurrentBridge.capture({
        turnId,
        eventId: "event-root-revision",
        submission: rootPatch("release"),
        turnEvidence: evidence(),
        dependencies: [rootScope],
      });
      concurrentDrain = concurrentBridge.drain();
      await concurrentDrain;
    } finally {
      releaseOldCapture();
      await Promise.allSettled(
        [firstDrain, concurrentDrain].filter(
          (drain): drain is ReturnType<typeof bridge.drain> => drain !== undefined,
        ),
      );
    }

    let finalDrainError: unknown;
    try {
      await concurrentBridge.drain();
    } catch (error) {
      finalDrainError = error;
    }
    const childPatches = requests.filter(
      ({ method, path }) => method === "PATCH" && path.endsWith(`/${CHILD_ID}`),
    );
    expect(childPatches.length).toBeGreaterThan(0);
    const childBranches = childPatches
      .map(({ payload }) => {
        const extra = payload["extra"];
        if (typeof extra !== "object" || extra === null || Array.isArray(extra)) return undefined;
        const patchMetadata = (extra as Record<string, unknown>)["metadata"];
        if (
          typeof patchMetadata !== "object" ||
          patchMetadata === null ||
          Array.isArray(patchMetadata)
        ) {
          return undefined;
        }
        const branch = (patchMetadata as Record<string, unknown>)["git_branch"];
        return typeof branch === "string" ? branch : undefined;
      })
      .filter((branch): branch is string => branch !== undefined);
    const firstNewerPatch = childBranches.indexOf("release");
    expect(firstNewerPatch).toBeGreaterThanOrEqual(0);
    expect(childBranches.slice(firstNewerPatch + 1)).not.toContain("main");
    expect(childPatches.at(-1)?.payload["extra"]).toMatchObject({
      metadata: { git_branch: "release" },
    });
    expect(storedRuns.get(CHILD_ID)?.["extra"]).toMatchObject({
      metadata: { git_branch: "release" },
    });
    expect(finalDrainError).toBeUndefined();
  });

  it("releases the settlement lock before a synchronous wake drains again", async () => {
    let drainOnWake = false;
    let bridge!: LifecycleBridge;
    const reentrantDrains: LifecycleDrainResult[] = [];
    bridge = createLifecycleBridge({
      storageRoot,
      integration: "claude-code",
      sessionId: "session-reentrant-wake",
      writer: {
        destinations: [{ apiKey: "synthetic-wake-key", apiUrl: endpoint, projectName: "wake" }],
        redact: false,
      },
      wake: async () => {
        if (drainOnWake) reentrantDrains.push(await bridge.drain());
      },
    });
    await bridge.capture({
      turnId: "turn-reentrant-wake",
      eventId: "event-root-wake",
      submission: post(ROOT_ID, "root", "main"),
      turnEvidence: evidence(),
    });
    await bridge.capture({
      turnId: "turn-reentrant-wake",
      eventId: "event-child-wake",
      submission: post(CHILD_ID, "tool"),
      turnEvidence: evidence(),
    });

    drainOnWake = true;
    await bridge.drain();

    expect(reentrantDrains).toHaveLength(1);
    expect(reentrantDrains[0]?.status).toBe("drained");
  });
});
