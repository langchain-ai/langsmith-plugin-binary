import { expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { EnumeratedCapture } from "../../storage/capture/models.js";
import type { TestSubmissionOptions } from "../../test-support/models/lifecycle.js";
import { temporaryRoot } from "../../test-support/tracing/delivery.js";
import {
  CHILD_ID,
  REPOSITORY,
  ROOT_ID,
  captureScope,
  runPatch,
  runPost,
  save,
  testBridge,
  turnEvidence,
} from "../../test-support/tracing/lifecycle.js";
import type { LifecycleTurnEvidence } from "../lifecycle/models.js";
import { refreshSettlementProgress, settleCapturedTurns } from "./pass.js";

const scope = (eventId: string, turnId = "turn") => captureScope("session-1", turnId, eventId);

async function fixture(
  evidence: LifecycleTurnEvidence = turnEvidence(),
  [rootId, childId] = ["root", "child"],
  rootOptions: TestSubmissionOptions = { base: REPOSITORY },
) {
  const root = temporaryRoot();
  const bridge = testBridge(root, "http://127.0.0.1:1/api/v1");
  const store = createCaptureStore(root);
  await save(bridge, "turn", rootId!, runPost("root", rootOptions), evidence);
  await save(bridge, "turn", childId!, runPost("child"), evidence, [scope(rootId!)]);
  const sources = async () =>
    (await store.enumerate("claude-code", "session-1")).filter(
      ({ record }) => record.eventKind !== "run-settlement-patch",
    );
  const receipts = async (
    captures: EnumeratedCapture[],
    destinations = ["a"],
    outcome: "delivered" | "dropped" = "delivered",
  ) => {
    for (const { record } of captures)
      for (const destination of destinations)
        await store.recordOutcome({
          ...scope(record.eventId, record.turnId),
          destination,
          outcome,
        });
  };
  const settle = async (destinations = ["a"], captures?: EnumeratedCapture[]) =>
    settleCapturedTurns({
      captures: captures ?? (await store.enumerate("claude-code", "session-1")),
      integration: "claude-code",
      sessionId: "session-1",
      destinationFingerprint: bridge.accountFingerprint,
      destinations: destinations.map((id) => ({ id })),
      capture: (input) =>
        store.capture({ ...input, integration: "claude-code", sessionId: "session-1" }),
      readOutcome: (target, destination) => store.readOutcome(target, destination),
      droppedRunIds: (turnId) => store.readDroppedRunIds("claude-code", "session-1", turnId),
      settledTurn: (turnId) => store.readSettledTurn("claude-code", "session-1", turnId),
    });
  return { bridge, store, sources, receipts, settle };
}

it("waits for authoritative root evidence but not for every destination to confirm", async () => {
  const turn = await fixture(turnEvidence("provisional"));
  await turn.receipts(await turn.sources());
  expect((await turn.settle()).progress.turns).toMatchObject([
    { status: "deferred", reason: "provisional" },
  ]);
  await save(
    turn.bridge,
    "turn",
    "closing",
    runPost("root", { base: REPOSITORY }),
    turnEvidence(),
    [scope("root")],
  );
  await turn.receipts((await turn.sources()).filter(({ record }) => record.eventId === "closing"));
  expect((await turn.settle(["a", "b"])).progress.turns).toMatchObject([
    { status: "pending", reason: "settlement-pending", patches: 1 },
  ]);
  await turn.receipts(await turn.sources(), ["b"]);
  expect((await turn.settle(["a", "b"])).progress.turns).toMatchObject([
    { status: "pending", reason: "settlement-pending", patches: 1 },
  ]);
});

it("defers a turn without a root run", async () => {
  const rootless = await fixture(turnEvidence("authoritative", [CHILD_ID], null));
  expect((await rootless.settle()).progress.turns).toMatchObject([
    { status: "deferred", reason: "missing-root" },
  ]);
});

it("keeps settling the rest of a turn when one destination dropped a child", async () => {
  const turn = await fixture();
  const sources = await turn.sources();
  await turn.receipts(sources.filter(({ record }) => record.runId !== CHILD_ID));
  await turn.receipts(
    sources.filter(({ record }) => record.runId === CHILD_ID),
    ["a"],
    "dropped",
  );
  const work = await turn.settle();
  expect(work.progress.turns).toMatchObject([{ status: "pending", reason: "settlement-pending" }]);
  expect(work.patches.length).toBeGreaterThan(0);
});

it("settles the surviving runs and warns once when a child was dropped and removed", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const turn = await fixture(turnEvidence(), undefined, {
    base: REPOSITORY,
    run: { end_time: "2026-10-10T12:00:01.000Z" },
  });
  const sources = await turn.sources();
  await turn.receipts(sources.filter(({ record }) => record.runId !== CHILD_ID));
  await turn.receipts(
    sources.filter(({ record }) => record.runId === CHILD_ID),
    ["a"],
    "dropped",
  );
  for (const { record } of sources.filter((source) => source.record.runId === CHILD_ID))
    await turn.store.remove(record);
  const first = await turn.settle();
  expect(first.patches.length).toBeGreaterThan(0);
  expect(first.progress.turns).toMatchObject([{ status: "pending", reason: "settlement-pending" }]);
  await turn.settle();
  const warnings = warn.mock.calls.filter(([message]) => String(message).includes(CHILD_ID));
  expect(warnings).toHaveLength(1);
  warn.mockRestore();
});

it("blocks a turn whose root run was dropped", async () => {
  const turn = await fixture();
  const sources = await turn.sources();
  await turn.receipts(sources, ["a"], "dropped");
  for (const { record } of sources.filter((source) => source.record.runId !== CHILD_ID))
    await turn.store.remove(record);
  expect((await turn.settle()).progress.turns).toMatchObject([
    { status: "blocked", reason: "source-dropped" },
  ]);
});

it("keeps run redactions on generated settlement patches", async () => {
  const turn = await fixture(turnEvidence("authoritative", []), undefined, {
    redactedFields: ["outputs"],
    run: { end_time: "2026-10-10T12:00:01.000Z" },
  });
  await turn.receipts(await turn.sources());
  await turn.settle();
  const settlement = (await turn.store.enumerate("claude-code", "session-1")).find(
    ({ record }) => record.eventKind === "run-settlement-patch",
  );
  expect(settlement?.record.normalizedPayload).toMatchObject({ redactedFields: ["outputs"] });
});

it("settles an external child post through its current-turn patch", async () => {
  const turn = await fixture(turnEvidence("authoritative", [], CHILD_ID), [
    "external-root",
    "external",
  ]);
  await save(
    turn.bridge,
    "parent",
    "root",
    runPost("root", { run: { end_time: "2026-10-10T12:00:01.000Z" } }),
  );
  await save(turn.bridge, "parent", "patch", runPatch("child", { outputs: {} }), turnEvidence(), [
    scope("root", "parent"),
  ]);
  await turn.receipts(await turn.sources());
  const work = await turn.settle();
  expect(work.progress.turns).toContainEqual(
    expect.objectContaining({ turnId: "parent", status: "pending", patches: 1 }),
  );
  expect(work.patches).toMatchObject([{ turnId: "parent", runId: ROOT_ID }]);
});

it("uses a new settlement event when attribution changes and orders same-time revisions", async () => {
  const turn = await fixture(turnEvidence(), ["z-root", "a-child"]);
  await turn.receipts(await turn.sources());
  const first = (await turn.settle()).patches[0]?.scope.eventId;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const release = runPatch("root", {}, { base: { ...REPOSITORY, ls_git_branch: "release" } });
  await save(turn.bridge, "turn", "b-revision", release, turnEvidence(), [scope("a-child")]);
  const captures = await turn.store.enumerate("claude-code", "session-1");
  await turn.receipts(captures);
  const sameTime = captures.map((capture) => ({
    ...capture,
    capturedAtMs: 1,
    record: { ...capture.record, capturedAtMs: 1 },
  }));
  const second = await turn.settle(["a"], sameTime);
  expect(second.patches).toHaveLength(1);
  expect(second.patches[0]?.scope.eventId).not.toBe(first);
  const settlements = (await turn.store.enumerate("claude-code", "session-1")).filter(
    ({ record }) => record.eventKind === "run-settlement-patch" && record.runId === CHILD_ID,
  );
  expect(settlements.at(-1)?.record.metadataProvenance).toMatchObject({
    base: { ls_git_branch: "release" },
  });
});

it("rejects cyclic source dependencies", async () => {
  const turn = await fixture();
  const cyclic = (await turn.store.enumerate("claude-code", "session-1")).map((capture) =>
    capture.record.runId === ROOT_ID
      ? { ...capture, record: { ...capture.record, dependencies: [scope("child")] } }
      : capture,
  );
  await expect(turn.settle(["a"], cyclic)).rejects.toThrow(
    "Source capture dependencies contain a cycle",
  );
});

it("clears pending details once every settlement patch is delivered", async () => {
  const progress = await refreshSettlementProgress(
    {
      progress: {
        captured: 1,
        turns: [
          {
            turnId: "turn",
            status: "pending",
            reason: "settlement-pending",
            destinations: ["a"],
            patches: 1,
          },
        ],
      },
      patches: [{ turnId: "turn", runId: CHILD_ID, scope: scope("patch") }],
    },
    [{ id: "a" }],
    async (target, destination) => ({
      status: "settled",
      receipt: {
        ...target,
        version: 1,
        destination,
        outcome: "delivered",
        recordedAt: "2026-10-10T12:00:00.000Z",
      },
    }),
  );
  expect(progress.turns).toEqual([{ turnId: "turn", status: "settled", patches: 1 }]);
});
