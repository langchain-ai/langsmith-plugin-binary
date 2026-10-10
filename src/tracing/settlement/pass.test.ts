import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import type {
  CaptureScope,
  CaptureStore,
  EnumeratedCapture,
} from "../../storage/capture/models.js";
import type { CodingAgentMetadataOptions } from "../../metadata/models.js";
import { createLifecycleBridge } from "../lifecycle/index.js";
import type { LifecycleTurnEvidence } from "../lifecycle/models.js";
import type { PreparedRunPatchSubmission, PreparedRunPostSubmission } from "../upload/models.js";
import { refreshSettlementProgress, settleCapturedTurns } from "./pass.js";

const SESSION_ID = "settlement-test-session";
const TURN_ID = "settlement-test-turn";
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

function metadata(runType: CodingAgentMetadataOptions["runType"]): CodingAgentMetadataOptions {
  return {
    integration: "claude-code",
    threadId: "thread-1",
    agentType: runType === "root" ? "root" : "subagent",
    runType,
  };
}

function post(
  id: string,
  runType: CodingAgentMetadataOptions["runType"],
  overrides: Partial<PreparedRunPostSubmission["run"]> = {},
  custom: Record<string, unknown> = {},
): PreparedRunPostSubmission {
  return {
    operation: "post",
    integration: "claude-code",
    privacyMode: "full",
    metadata: { ...metadata(runType), base: custom },
    run: {
      id,
      name: "test run",
      run_type: runType === "root" ? "chain" : "tool",
      inputs: {},
      ...(id === ROOT_ID
        ? { start_time: "2026-10-10T12:00:00.000Z", trace_id: ROOT_ID, dotted_order: ROOT_ORDER }
        : {
            start_time: "2026-10-10T12:00:00.001Z",
            parent_run_id: ROOT_ID,
            trace_id: ROOT_ID,
            dotted_order: CHILD_ORDER,
          }),
      ...overrides,
    },
  };
}

function evidence(
  closureState: LifecycleTurnEvidence["closureState"],
  includeRoot = true,
): LifecycleTurnEvidence {
  return {
    ...(includeRoot ? { rootRunId: ROOT_ID } : {}),
    childRunIds: [CHILD_ID],
    closureState,
  };
}

async function fixture(
  closureState: LifecycleTurnEvidence["closureState"],
  includeRoot = true,
  rootEventId = "event-root",
  childEventId = "event-child",
) {
  const storageRoot = await mkdtemp(join(tmpdir(), "plugins-base-settlement-pass-"));
  const bridge = createLifecycleBridge({
    storageRoot,
    integration: "claude-code",
    sessionId: SESSION_ID,
    writer: {
      destinations: [
        {
          apiKey: "synthetic-settlement-key",
          apiUrl: "http://127.0.0.1:1/api/v1",
          projectName: "settlement-test",
        },
      ],
      redact: false,
    },
  });
  const store = createCaptureStore(storageRoot);
  const rootScope = scope(rootEventId);
  await bridge.capture({
    turnId: TURN_ID,
    eventId: rootScope.eventId,
    submission: post(ROOT_ID, "root", {}, REPOSITORY),
    turnEvidence: evidence(closureState, includeRoot),
  });
  await bridge.capture({
    turnId: TURN_ID,
    eventId: childEventId,
    submission: post(CHILD_ID, "tool"),
    turnEvidence: evidence(closureState, includeRoot),
    dependencies: [rootScope],
  });
  return { bridge, store };
}

function scope(eventId: string, turnId = TURN_ID): CaptureScope {
  return { integration: "claude-code", sessionId: SESSION_ID, turnId, eventId };
}

async function sourceCaptures(store: CaptureStore): Promise<EnumeratedCapture[]> {
  return (await store.enumerate("claude-code", SESSION_ID)).filter(
    ({ record }) => record.eventKind !== "run-settlement-patch",
  );
}

async function recordReceipts(
  store: CaptureStore,
  captures: readonly EnumeratedCapture[],
  destinations: readonly string[],
  outcome: "delivered" | "dropped" = "delivered",
): Promise<void> {
  for (const { record } of captures) {
    for (const destination of destinations) {
      const receipt = await store.recordOutcome({
        ...scope(record.eventId, record.turnId),
        destination,
        outcome,
      });
      if (receipt.status !== "recorded" && receipt.status !== "duplicate") {
        throw new Error(`Could not record ${outcome} receipt: ${receipt.status}`);
      }
    }
  }
}

async function settle(
  store: CaptureStore,
  bridge: Awaited<ReturnType<typeof fixture>>["bridge"],
  destinations: readonly string[],
  captures?: readonly EnumeratedCapture[],
) {
  return settleCapturedTurns({
    captures: captures ?? (await store.enumerate("claude-code", SESSION_ID)),
    integration: "claude-code",
    sessionId: SESSION_ID,
    destinationFingerprint: bridge.accountFingerprint,
    destinations: destinations.map((id) => ({ id })),
    capture: (input) =>
      store.capture({ ...input, integration: "claude-code", sessionId: SESSION_ID }),
    readOutcome: (captureScope, destination) => store.readOutcome(captureScope, destination),
  });
}

describe("captured turn settlement", () => {
  it("waits for authoritative root evidence before settling", async () => {
    const { bridge, store } = await fixture("provisional");
    const captures = await sourceCaptures(store);
    await recordReceipts(store, captures, ["destination-a"]);

    const provisional = await settle(store, bridge, ["destination-a"]);
    expect(provisional.progress.turns).toMatchObject([
      { status: "deferred", reason: "provisional", patches: 0 },
    ]);

    await bridge.capture({
      turnId: TURN_ID,
      eventId: "event-authoritative",
      submission: post(ROOT_ID, "root", {}, REPOSITORY),
      turnEvidence: evidence("authoritative"),
      dependencies: [scope("event-root")],
    });
    const authoritativeCapture = (await sourceCaptures(store)).find(
      ({ record }) => record.eventId === "event-authoritative",
    )!;
    await recordReceipts(store, [authoritativeCapture], ["destination-a"]);

    const recovered = await settle(store, bridge, ["destination-a"]);
    expect(recovered.progress.turns).toMatchObject([
      { status: "pending", reason: "settlement-pending", patches: 1 },
    ]);
  });

  it("preserves run redactions in generated settlement patches", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "plugins-base-settlement-redactions-"));
    const bridge = createLifecycleBridge({
      storageRoot,
      integration: "claude-code",
      sessionId: SESSION_ID,
      writer: {
        destinations: [
          {
            apiKey: "synthetic-settlement-key",
            apiUrl: "http://127.0.0.1:1/api/v1",
            projectName: "settlement-test",
          },
        ],
        redact: false,
      },
    });
    const store = createCaptureStore(storageRoot);
    await bridge.capture({
      turnId: TURN_ID,
      eventId: "event-redacted-root",
      submission: {
        ...post(ROOT_ID, "root", { end_time: "2026-10-10T12:00:01.000Z" }),
        redactedFields: ["outputs"],
      },
      turnEvidence: {
        rootRunId: ROOT_ID,
        childRunIds: [],
        closureState: "authoritative",
      },
    });
    const captures = await sourceCaptures(store);
    await recordReceipts(store, captures, ["destination-a"]);

    await settle(store, bridge, ["destination-a"]);

    const settlement = (await store.enumerate("claude-code", SESSION_ID)).find(
      ({ record }) => record.eventKind === "run-settlement-patch",
    );
    expect(settlement?.record.normalizedPayload).toMatchObject({ redactedFields: ["outputs"] });
  });

  it("reports authoritative evidence without a root run as deferred", async () => {
    const { bridge, store } = await fixture("authoritative", false);
    const work = await settle(store, bridge, ["destination-a"]);
    expect(work.progress.turns).toMatchObject([
      { status: "deferred", reason: "missing-root", patches: 0 },
    ]);
  });

  it("blocks attribution when a required child was dropped", async () => {
    const { bridge, store } = await fixture("authoritative");
    const captures = await sourceCaptures(store);
    const child = captures.find(({ record }) => record.runId === CHILD_ID)!;
    await recordReceipts(
      store,
      captures.filter(({ record }) => record.runId !== CHILD_ID),
      ["destination-a"],
    );
    await recordReceipts(store, [child], ["destination-a"], "dropped");

    const work = await settle(store, bridge, ["destination-a"]);
    expect(work.progress.turns).toMatchObject([
      { status: "blocked", reason: "source-dropped", patches: 0 },
    ]);
  });

  it("waits for source receipts from every destination", async () => {
    const { bridge, store } = await fixture("authoritative");
    const captures = await sourceCaptures(store);
    await recordReceipts(store, captures, ["destination-a"]);

    const partial = await settle(store, bridge, ["destination-a", "destination-b"]);
    expect(partial.progress.turns).toMatchObject([
      { status: "pending", reason: "source-pending", patches: 0, destinations: ["destination-b"] },
    ]);

    await recordReceipts(store, captures, ["destination-b"]);
    const complete = await settle(store, bridge, ["destination-a", "destination-b"]);
    expect(complete.progress.turns).toMatchObject([
      { status: "pending", reason: "settlement-pending", patches: 1 },
    ]);
  });

  it("settles an external child post with its current-turn patch", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "plugins-base-cross-turn-child-patch-"));
    const bridge = createLifecycleBridge({
      storageRoot,
      integration: "claude-code",
      sessionId: SESSION_ID,
      writer: {
        destinations: [
          {
            apiKey: "synthetic-settlement-key",
            apiUrl: "http://127.0.0.1:1/api/v1",
            projectName: "settlement-test",
          },
        ],
        redact: false,
      },
    });
    const store = createCaptureStore(storageRoot);
    const parentTurnId = "settlement-parent-turn";
    const childTurnId = "settlement-subagent-turn";
    const rootScope = scope("event-cross-turn-root", parentTurnId);
    await bridge.capture({
      turnId: childTurnId,
      eventId: "event-external-child-post",
      submission: post(CHILD_ID, "tool"),
      turnEvidence: {
        rootRunId: CHILD_ID,
        childRunIds: [],
        closureState: "authoritative",
      },
    });
    await bridge.capture({
      turnId: parentTurnId,
      eventId: rootScope.eventId,
      submission: post(ROOT_ID, "root", { end_time: "2026-10-10T12:00:01.000Z" }),
      turnEvidence: evidence("authoritative"),
    });
    await bridge.capture({
      turnId: parentTurnId,
      eventId: "event-current-child-patch",
      submission: {
        operation: "patch",
        integration: "claude-code",
        privacyMode: "full",
        metadata: metadata("tool"),
        run: {
          id: CHILD_ID,
          name: "test run",
          run_type: "tool",
          start_time: "2026-10-10T12:00:00.001Z",
          parent_run_id: ROOT_ID,
          trace_id: ROOT_ID,
          dotted_order: CHILD_ORDER,
        },
        privacyContext: { status: "completed" },
        patch: { fields: ["outputs"], values: { outputs: { result: "done" } } },
      },
      turnEvidence: evidence("authoritative"),
      dependencies: [rootScope],
    });
    const captures = await sourceCaptures(store);
    await recordReceipts(store, captures, ["destination-a"]);

    const work = await settle(store, bridge, ["destination-a"]);

    expect(work.progress.turns).toContainEqual(
      expect.objectContaining({
        turnId: parentTurnId,
        status: "pending",
        reason: "settlement-pending",
        patches: 1,
      }),
    );
    expect(work.patches).toMatchObject([{ turnId: parentTurnId, runId: ROOT_ID }]);
  });

  it("uses a new settlement event when captured attribution changes", async () => {
    const { bridge, store } = await fixture("authoritative");
    const initialCaptures = await sourceCaptures(store);
    await recordReceipts(store, initialCaptures, ["destination-a"]);
    const first = await settle(store, bridge, ["destination-a"]);
    const firstEventId = first.patches[0]?.scope.eventId;
    expect(firstEventId).toMatch(/^turn-settlement-/);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await bridge.capture({
      turnId: TURN_ID,
      eventId: "event-root-revision",
      submission: post(ROOT_ID, "root", {}, { ...REPOSITORY, git_branch: "release" }),
      turnEvidence: evidence("authoritative"),
      dependencies: [scope("event-root")],
    });
    const revision = (await sourceCaptures(store)).find(
      ({ record }) => record.eventId === "event-root-revision",
    )!;
    await recordReceipts(store, [revision], ["destination-a"]);
    const second = await settle(store, bridge, ["destination-a"]);

    expect(second.patches).toHaveLength(1);
    expect(second.patches[0]?.scope.eventId).toMatch(/^turn-settlement-/);
    expect(second.patches[0]?.scope.eventId).not.toBe(firstEventId);
  });

  it("orders transitive source dependencies before applying a same-time root revision", async () => {
    const { bridge, store } = await fixture("authoritative", true, "z-root", "a-child");
    const revision: PreparedRunPatchSubmission = {
      operation: "patch",
      integration: "claude-code",
      privacyMode: "full",
      metadata: { ...metadata("root"), base: { ...REPOSITORY, git_branch: "release" } },
      run: {
        id: ROOT_ID,
        name: "test run",
        run_type: "chain",
        start_time: "2026-10-10T12:00:00.000Z",
        trace_id: ROOT_ID,
        dotted_order: ROOT_ORDER,
      },
      privacyContext: { status: "completed" },
      patch: { fields: [], values: {} },
    };
    await bridge.capture({
      turnId: TURN_ID,
      eventId: "b-root-revision",
      submission: revision,
      turnEvidence: evidence("authoritative"),
      dependencies: [scope("a-child")],
    });
    const captures = await store.enumerate("claude-code", SESSION_ID);
    await recordReceipts(store, captures, ["destination-a"]);
    const sameTimeCaptures = captures.map((capture) => ({
      ...capture,
      capturedAtMs: 1,
      record: { ...capture.record, capturedAtMs: 1 },
    }));

    const work = await settle(store, bridge, ["destination-a"], sameTimeCaptures);
    const childSettlement = (await store.enumerate("claude-code", SESSION_ID)).find(
      ({ record }) => record.eventKind === "run-settlement-patch" && record.runId === CHILD_ID,
    );

    expect(work.patches).toHaveLength(1);
    expect(childSettlement?.record.metadataProvenance).toMatchObject({
      base: { git_branch: "release" },
    });
  });

  it("rejects cycles in source capture dependencies", async () => {
    const { bridge, store } = await fixture("authoritative");
    const captures = await store.enumerate("claude-code", SESSION_ID);
    const cyclicCaptures = captures.map((capture) =>
      capture.record.runId === ROOT_ID
        ? { ...capture, record: { ...capture.record, dependencies: [scope("event-child")] } }
        : capture,
    );

    await expect(settle(store, bridge, ["destination-a"], cyclicCaptures)).rejects.toThrow(
      "Source capture dependencies contain a cycle",
    );
  });

  it("removes stale pending details after every settlement patch is delivered", async () => {
    const work = {
      progress: {
        captured: 1,
        turns: [
          {
            turnId: TURN_ID,
            status: "pending" as const,
            reason: "settlement-pending" as const,
            destinations: ["destination-a"],
            patches: 1,
          },
        ],
      },
      patches: [{ turnId: TURN_ID, runId: CHILD_ID, scope: scope("turn-settlement-patch") }],
    };
    const progress = await refreshSettlementProgress(
      work,
      [{ id: "destination-a" }],
      async (captureScope, destination) => ({
        status: "settled",
        receipt: {
          ...captureScope,
          version: 1,
          destination,
          outcome: "delivered",
          recordedAt: "2026-10-10T12:00:00.000Z",
        },
      }),
    );

    expect(progress.turns[0]).toMatchObject({ status: "settled", patches: 1 });
    expect(progress.turns[0]).not.toHaveProperty("reason");
    expect(progress.turns[0]).not.toHaveProperty("destinations");
  });
});
