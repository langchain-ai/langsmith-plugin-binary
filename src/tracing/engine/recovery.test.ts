import { utimesSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { CaptureStore } from "../../storage/capture/models.js";
import { eventPath } from "../../storage/capture/paths.js";
import { temporaryRoot } from "../../test-support/tracing/delivery.js";
import {
  CHILD_ID,
  captureScope,
  runPatch,
  runPost,
  save,
  testBridge,
  turnEvidence,
  writerFor,
} from "../../test-support/tracing/lifecycle.js";
import { createReconstructionWorker } from "../reconstruction/index.js";
import { settleCapturedTurns } from "../settlement/pass.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import type { TracingEngineRecoveryOptions, TracingEngineSession } from "./models.js";
import { fillTemplate } from "../../utils/format.js";
import { DELIVERY_ACCOUNT_MISMATCH_WARNING } from "../delivery/constants.js";
import { TRACING_ENGINE_RECOVERY_MAX_FOREIGN_SESSIONS } from "./constants.js";
import { recoverTracingSessions } from "./recovery.js";

const URL = "http://127.0.0.1:1/api/v1";
const writer = writerFor(URL);
const { accountFingerprint, destinations } = createLangSmithUploadWriter(writer);
const later = { minimumForeignAgeMs: 60_000, now: Date.now() + 3_600_000 };
const callbacks = () => ({
  reconstruct: vi.fn(),
  scheduleWake: vi.fn(),
  resolveScope: vi.fn(),
});

function recover(root: string, request: Partial<TracingEngineRecoveryOptions> = {}) {
  const created: string[] = [];
  const wakes: string[] = [];
  const report = recoverTracingSessions(
    {
      storageRoot: root,
      integration: "claude-code",
      accountFingerprint,
      writer,
      currentSessionId: "current",
      wakeCurrent: async () => (wakes.push("current"), "launched"),
      createSession: (options) => {
        created.push(options.sessionId);
        return { wake: async () => "queued" } as unknown as TracingEngineSession;
      },
    },
    { optionsForSession: callbacks, minimumForeignAgeMs: 0, ...request },
  );
  return { report, created, wakes };
}

function ageFile(path: string, seconds: number): void {
  const at = new Date(Date.now() - seconds * 1_000);
  utimesSync(path, at, at);
}

const pending = (root: string, sessionId: string, apiKey?: string) =>
  save(
    testBridge(root, URL, { sessionId, writer: writerFor(URL, apiKey) }),
    "turn",
    "root",
    runPost("root"),
    turnEvidence("open", []),
  );

async function deliverAll(
  store: CaptureStore,
  sessionId: string,
  outcome: "delivered" | "dropped" = "delivered",
) {
  for (const { record } of await store.enumerate("claude-code", sessionId))
    for (const { id } of destinations)
      await store.recordOutcome({
        ...captureScope(sessionId, record.turnId, record.eventId),
        destination: id,
        outcome,
      });
}

const child = () =>
  runPost("child", {
    base: { repository_name: "acme/project" },
    run: { end_time: "2026-10-10T12:00:01.000Z" },
  });

async function settledSession(
  root: string,
  sessionId: string,
  settle: boolean,
  childTurn = "turn",
) {
  const bridge = testBridge(root, URL, { sessionId });
  const store = createCaptureStore(root);
  await save(
    bridge,
    "turn",
    "root",
    runPost("root", { run: { end_time: "2026-10-10T12:00:01.000Z" } }),
  );
  const childEvidence =
    childTurn === "turn" ? turnEvidence() : turnEvidence("authoritative", [], CHILD_ID);
  await save(bridge, childTurn, "child", child(), childEvidence, [
    captureScope(sessionId, "turn", "root"),
  ]);
  await deliverAll(store, sessionId);
  const settleNow = async () =>
    settleCapturedTurns({
      captures: await store.enumerate("claude-code", sessionId),
      integration: "claude-code",
      sessionId,
      destinationFingerprint: accountFingerprint,
      destinations,
      capture: (input) => store.capture({ ...input, integration: "claude-code", sessionId }),
      readOutcome: (scope, destination) => store.readOutcome(scope, destination),
      droppedRunIds: (turnId) => store.readDroppedRunIds("claude-code", sessionId, turnId),
      settledTurn: (turnId) => store.readSettledTurn("claude-code", sessionId, turnId),
    });
  if (settle) await settleNow().then(() => deliverAll(store, sessionId));
  return { bridge, store, child, childEvidence, settleNow };
}

it("wakes at most one pass worth of sessions and wakes them side by side", async () => {
  const root = temporaryRoot();
  const sessions = Array.from(
    { length: TRACING_ENGINE_RECOVERY_MAX_FOREIGN_SESSIONS + 5 },
    (_, n) => `session-${String(n).padStart(2, "0")}`,
  );
  for (const sessionId of sessions) await pending(root, sessionId);
  let active = 0;
  let peak = 0;
  const report = await recoverTracingSessions(
    {
      storageRoot: root,
      integration: "claude-code",
      accountFingerprint,
      writer,
      currentSessionId: "current",
      wakeCurrent: async () => "launched",
      createSession: () =>
        ({
          wake: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return "queued";
          },
        }) as unknown as TracingEngineSession,
    },
    { optionsForSession: callbacks, minimumForeignAgeMs: 0, now: Date.now() + 60_000 },
  );
  expect(report.scheduled).toHaveLength(TRACING_ENGINE_RECOVERY_MAX_FOREIGN_SESSIONS);
  expect(peak).toBeGreaterThan(1);
}, 30_000);

it("warns, naming the cause, about saved work that belongs to another upload setting", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const root = temporaryRoot();
  await pending(root, "other-setting", "synthetic-other-key");
  await recover(root).report;
  expect(warn).toHaveBeenCalledWith(fillTemplate(DELIVERY_ACCOUNT_MISMATCH_WARNING, { count: 1 }));
  warn.mockRestore();
});

it("wakes the sessions with the oldest pending work first", async () => {
  const root = temporaryRoot();
  const sessions = Array.from(
    { length: TRACING_ENGINE_RECOVERY_MAX_FOREIGN_SESSIONS + 3 },
    (_, n) => `session-${String(n).padStart(2, "0")}`,
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    for (const sessionId of sessions.toReversed()) {
      await pending(root, sessionId);
      vi.setSystemTime(Date.now() + 1_000);
    }
  } finally {
    vi.useRealTimers();
  }
  const { report } = recover(root, { now: Date.now() + 60_000 });
  const woken = (await report).scheduled.map(({ sessionId }) => sessionId);
  expect(woken).toHaveLength(TRACING_ENGINE_RECOVERY_MAX_FOREIGN_SESSIONS);
  expect(woken).not.toContain(sessions[0]);
  expect(woken).toContain(sessions.at(-1));
});

it("skips a session whose pending work is still waiting for its retry time", async () => {
  const root = temporaryRoot();
  await pending(root, "waiting");
  await pending(root, "ready");
  const store = createCaptureStore(root);
  for (const { record } of await store.enumerate("claude-code", "waiting"))
    for (const { id } of destinations)
      await store.recordRetry(captureScope("waiting", record.turnId, record.eventId), id, {
        failures: 1,
        notBeforeMs: Date.now() + 3_600_000,
      });
  const { report } = recover(root, { now: Date.now() + 60_000 });
  expect((await report).scheduled.map(({ sessionId }) => sessionId)).toEqual(["ready"]);
});

it("recovers a session whose retry time was set by an earlier process", async () => {
  const root = temporaryRoot();
  await pending(root, "stranded");
  const store = createCaptureStore(root);
  for (const { record } of await store.enumerate("claude-code", "stranded"))
    for (const { id } of destinations)
      await store.recordRetry(captureScope("stranded", record.turnId, record.eventId), id, {
        failures: 6,
        recordedAtMs: 1,
        notBeforeMs: Date.now() + 3_600_000,
      });
  const { report } = recover(root, { now: Date.now() + 60_000 });
  expect((await report).scheduled.map(({ sessionId }) => sessionId)).toEqual(["stranded"]);
});

it("does not treat work saved at or after the recovery time as too young when no minimum age is set", async () => {
  const root = temporaryRoot();
  await pending(root, "just-saved");
  const { report } = recover(root, { minimumForeignAgeMs: 0, now: Date.now() - 60_000 });
  expect((await report).scheduled.map(({ sessionId }) => sessionId)).toEqual(["just-saved"]);
});

it("reports failed sessions and keeps recovering healthy ones", async () => {
  const root = temporaryRoot();
  for (const sessionId of ["failed", "healthy"]) await pending(root, sessionId);
  const { report, created } = recover(root, {
    now: Date.now() + 60_000,
    optionsForSession: (sessionId) => {
      if (sessionId === "failed") throw new Error("missing wake callback");
      return callbacks();
    },
  });
  await expect(report).resolves.toEqual({
    scheduled: [{ sessionId: "healthy", status: "queued" }],
    failed: [{ sessionId: "failed", message: "missing wake callback" }],
  });
  expect(created).toEqual(["healthy"]);
});

it("wakes stale current, foreign and reconstruction work but skips young and other-account work", async () => {
  const root = temporaryRoot();
  const now = Date.now();
  for (const [sessionId, key] of [["stale"], ["other-account", "synthetic-other-key"]] as const)
    await pending(root, sessionId, key);
  for (const [sessionId, account] of [
    ["reconstruction", accountFingerprint],
    ["other-reconstruction", "other-account"],
  ] as const)
    await createReconstructionWorker({
      storageRoot: root,
      integration: "claude-code",
      sessionId,
      bridge: { accountFingerprint: account, capture: vi.fn() },
      reconstruct: vi.fn(),
    }).enqueue({
      turnId: "turn",
      eventId: "job",
      sourceRefs: ["source"],
      privacyMode: "full",
      turnEvidence: { childRunIds: [], closureState: "open" },
    });
  for (const sessionId of ["stale", "other-account"])
    ageFile(eventPath(root, captureScope(sessionId, "turn", "root")), 120);
  for (const sessionId of ["reconstruction", "other-reconstruction"])
    ageFile(eventPath({ root, directory: "jobs" }, captureScope(sessionId, "turn", "job")), 120);
  await pending(root, "young");
  await pending(root, "current");
  const { report, created, wakes } = recover(root, { minimumForeignAgeMs: 60_000, now });
  const result = await report;
  expect(result.failed).toEqual([]);
  expect(result.scheduled).toHaveLength(3);
  expect(result.scheduled).toEqual(
    expect.arrayContaining([
      { sessionId: "current", status: "launched" },
      { sessionId: "reconstruction", status: "queued" },
      { sessionId: "stale", status: "queued" },
    ]),
  );
  expect([created.toSorted(), wakes]).toEqual([["reconstruction", "stale"], ["current"]]);
  const excluded = recover(root, {
    excludeCurrentSession: true,
    optionsForSession: () => Promise.reject(new Error("no")),
  });
  await expect(excluded.report).resolves.toMatchObject({ scheduled: [] });
  expect(excluded.wakes).toEqual([]);
});

it("leaves a stuck foreign session alone while its uploads are being attempted", async () => {
  const root = temporaryRoot();
  await pending(root, "stuck");
  const path = eventPath(root, captureScope("stuck", "turn", "root"));
  ageFile(path, 120);
  const options = { minimumForeignAgeMs: 60_000 };
  await expect(recover(root, options).report).resolves.toMatchObject({
    scheduled: [{ sessionId: "stuck", status: "queued" }],
  });
  await createCaptureStore(root).recordRetry(captureScope("stuck", "turn", "root"), "primary", {
    failures: 1,
    notBeforeMs: Date.now(),
  });
  await expect(recover(root, options).report).resolves.toEqual({ scheduled: [], failed: [] });
});

it("does not wake a session whose pending work waits for a prerequisite that is gone", async () => {
  const root = temporaryRoot();
  const bridge = testBridge(root, URL, { sessionId: "orphan" });
  await save(
    bridge,
    "turn",
    "late",
    runPatch("root", { end_time: "2026-10-10T12:00:01.000Z" }),
    turnEvidence(),
    [captureScope("orphan", "turn", "removed-post")],
  );
  await pending(root, "waiting");
  const { report, created } = recover(root, later);
  await expect(report).resolves.toMatchObject({
    scheduled: [{ sessionId: "waiting" }],
    failed: [],
  });
  expect(created).toEqual(["waiting"]);
});

it("recovers delivered sources only while their settlement is missing or can still progress", async () => {
  const root = temporaryRoot();
  await settledSession(root, "settled", true);
  await settledSession(root, "unsettled", false);
  const crossTurn = await settledSession(root, "cross-turn", true, "child-turn");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await save(crossTurn.bridge, "child-turn", "newer", crossTurn.child(), crossTurn.childEvidence, [
    captureScope("cross-turn", "turn", "root"),
  ]);
  const settlements = async () =>
    (await crossTurn.store.enumerate("claude-code", "cross-turn"))
      .filter(
        ({ record }) => record.eventKind === "run-settlement-patch" && record.turnId === "turn",
      )
      .map(({ record }) => record.eventId);
  const earlier = await settlements();
  await deliverAll(crossTurn.store, "cross-turn");
  await crossTurn.settleNow();
  for (const eventId of (await settlements()).filter((id) => !earlier.includes(id)))
    await crossTurn.store.recordOutcome({
      ...captureScope("cross-turn", "turn", eventId),
      destination: destinations[0]!.id,
      outcome: "dropped",
    });
  await deliverAll(crossTurn.store, "cross-turn");
  const { report, created } = recover(root, later);
  await expect(report).resolves.toMatchObject({ failed: [] });
  expect(created).toEqual(["unsettled"]);
});
