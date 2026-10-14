import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { identifierHash } from "../../storage/capture/paths.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { LocalEndpoint } from "../../test-support/models/lifecycle.js";
import {
  childEnvironment,
  expectNoFilesLeft,
  expectNoPathsLeft,
  filesUnder,
  moduleUrl,
  temporaryRoot,
} from "../../test-support/tracing/delivery.js";
import {
  localEndpoint,
  runPost,
  testBridge,
  turnEvidence,
  writerFor,
} from "../../test-support/tracing/lifecycle.js";
import type { ReconstructionCallback } from "../reconstruction/models.js";
import type { PreparedRunPostSubmission } from "../upload/models.js";
import { createTracingEngine } from "./engine.js";

vi.mock("../delivery/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../delivery/constants.js")>()),
  DELIVERY_QUICK_RETRY_MS: 0,
}));

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: (ms?: number) => actual.setTimeout((ms ?? 0) >= 1_000 ? 0 : ms) };
});

const HOUR_MS = 60 * 60 * 1000;
const runId = (index: number) => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
let endpoint: LocalEndpoint;
let root: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  endpoint = await localEndpoint();
  root = temporaryRoot();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await endpoint.close();
  vi.restoreAllMocks();
});

function submission(id: string): PreparedRunPostSubmission {
  return runPost("root", {
    run: {
      id,
      trace_id: id,
      dotted_order: `20261010T120000000000Z${id}`,
      end_time: "2026-10-10T12:00:01.000Z",
    },
  });
}

function open(sessionId = "session-disk", reconstruct?: ReconstructionCallback) {
  return createTracingEngine({
    storageRoot: root,
    integration: "claude-code",
    writer: writerFor(endpoint.url),
  }).forSession({
    sessionId,
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      throw new Error("no worker in this test");
    },
    reconstruct:
      reconstruct ?? (async () => ({ status: "deferred", reason: "missing-thread-identity" })),
  });
}

async function finishedTurn(session: ReturnType<typeof open>, index: number) {
  await session
    .capture({
      turnId: `turn-${index}`,
      eventId: `event-${index}`,
      submission: submission(runId(index)),
      turnEvidence: { rootRunId: runId(index), childRunIds: [], closureState: "authoritative" },
    })
    .catch(() => undefined);
}

function posts(): string[] {
  return endpoint.requests
    .filter(({ method }) => method === "POST")
    .map(({ payload }) => String(payload["id"]));
}

it("leaves no files after reconstruction jobs are delivered", async () => {
  const session = open("session-disk", async (job) => ({
    status: "ready",
    outputs: [
      {
        eventId: `output-${job.eventId}`,
        submission: submission(job.sourceRefs[0]!),
        turnEvidence: job.turnEvidence,
      },
    ],
  }));
  for (let index = 0; index < 5; index += 1)
    await session
      .queueReconstruction({
        turnId: `job-turn-${index}`,
        eventId: `job-${index}`,
        sourceRefs: [runId(100 + index)],
        privacyMode: "full",
        turnEvidence: {
          rootRunId: runId(100 + index),
          childRunIds: [],
          closureState: "authoritative",
        },
      })
      .catch(() => undefined);
  await expect(session.drain()).resolves.toBe("completed");
  expect(posts()).toHaveLength(5);
  expectNoPathsLeft(root);
}, 30_000);

it("clears every file once work saved during an outage is delivered", async () => {
  const session = open();
  endpoint.state.mode = "down";
  for (let index = 0; index < 3; index += 1) await finishedTurn(session, index);
  await expect(session.drain()).resolves.toBe("deferred");
  expect(filesUnder(root).length).toBeGreaterThan(0);
  endpoint.state.mode = "ok";
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  await session.wake().catch(() => undefined);
  await expect(session.drain()).resolves.toBe("completed");
  clock.mockRestore();
  expect(new Set(posts())).toEqual(new Set([runId(0), runId(1), runId(2)]));
  expectNoPathsLeft(root);
});

it("saves a capture and hands delivery to the worker without contacting the service", async () => {
  endpoint.state.mode = "hang";
  const wake = vi.fn(() => 1);
  const session = createTracingEngine({
    storageRoot: root,
    integration: "claude-code",
    writer: writerFor(endpoint.url),
  }).forSession({
    sessionId: "session-disk",
    resolveScope: (expected) => expected,
    scheduleWake: wake,
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
  });
  await session
    .capture({
      turnId: "turn-1",
      eventId: "event-1",
      submission: submission(runId(1)),
      turnEvidence: { rootRunId: runId(1), childRunIds: [], closureState: "authoritative" },
    })
    .catch(() => undefined);
  expect(endpoint.requests).toEqual([]);
  expect(wake).toHaveBeenCalled();
});

async function crashAnUpload(index: number): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./fixtures/disk-crash-worker.mjs", import.meta.url)),
      moduleUrl("dist/tracing/index.js"),
      JSON.stringify({
        root,
        sessionId: "session-disk",
        writer: writerFor(endpoint.url),
        runIds: [runId(1)],
      }),
    ],
    { env: childEnvironment(temporaryRoot()), stdio: "ignore" },
  );
  children.push(child);
  await vi.waitFor(() => expect(endpoint.requests.length).toBeGreaterThan(index), {
    timeout: 15_000,
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

it("clears the leftovers of six killed upload attempts once the work is delivered", async () => {
  endpoint.state.mode = "hang";
  for (let index = 0; index < 6; index += 1) await crashAnUpload(index);
  const strays = [
    join(
      root,
      "sessions",
      "wake-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.active.11111111-0000-4000-8000-000000000000.json",
    ),
    join(root, "sessions", ".22222222-0000-4000-8000-000000000000.tmp"),
  ];
  for (const stray of strays) {
    mkdirSync(join(stray, ".."), { recursive: true });
    writeFileSync(stray, "{}");
    const old = new Date(Date.now() - 3 * HOUR_MS);
    utimesSync(stray, old, old);
  }
  endpoint.state.mode = "ok";
  endpoint.requests.length = 0;
  await expect(open().drain()).resolves.toBe("completed");
  expect(posts()).toEqual([runId(1)]);
  expect(strays.some(existsSync)).toBe(false);
  expectNoPathsLeft(root);
}, 90_000);

it("removes a session that ended without a Stop once its work is six hours old", async () => {
  const lifecycle = testBridge(root, endpoint.url, { sessionId: "session-no-stop" });
  await lifecycle.capture({
    turnId: "turn",
    eventId: "open",
    submission: runPost("root"),
    turnEvidence: turnEvidence("open", [], null),
  });
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 1, pending: 0 });
  expect(filesUnder(root)).toHaveLength(1);
  await lifecycle.drain({ now: Date.now() + 5 * HOUR_MS });
  expect(filesUnder(root)).toHaveLength(1);
  await lifecycle.drain({ now: Date.now() + 7 * HOUR_MS });
  expectNoFilesLeft(root);
  await expect(createCaptureStore(root).enumerateSessions("claude-code")).resolves.toEqual([]);
});

it("delivers each run once when two hooks finish together", async () => {
  const [first, second] = [open(), open()];
  for (let index = 0; index < 4; index += 1)
    await finishedTurn(index % 2 === 0 ? first : second, index);
  await Promise.all([first.drain(), second.drain(), first.drain(), second.drain()]);
  expect(posts().toSorted()).toEqual([0, 1, 2, 3].map(runId));
  expectNoFilesLeft(root);
}, 30_000);

it("keeps only turn markers in the exact session tree after delivery and removes every folder after expiry", async () => {
  const sessions = ["session-a", "session-b"] as const;
  for (const [index, sessionId] of sessions.entries()) {
    const session = open(sessionId);
    await finishedTurn(session, index * 2);
    await finishedTurn(session, index * 2 + 1);
    await session.drain();
  }
  expect(posts().toSorted()).toEqual([0, 1, 2, 3].map(runId));
  expect(
    filesUnder(root)
      .map((path) => relative(root, path))
      .toSorted(),
  ).toEqual(
    sessions
      .flatMap((sessionId, index) =>
        [index * 2, index * 2 + 1].map((turn) =>
          join(
            "sessions",
            identifierHash(sessionId),
            "turns",
            identifierHash(`turn-${turn}`),
            "turn.outcome",
          ),
        ),
      )
      .toSorted(),
  );
  await testBridge(root, endpoint.url, { sessionId: sessions[0] }).drain({
    now: Date.now() + 25 * HOUR_MS,
  });
  expect(filesUnder(root)).toEqual([]);
  expect(existsSync(join(root, "sessions"))).toBe(false);
});
