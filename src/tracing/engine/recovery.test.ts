import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { CaptureInput } from "../../storage/capture/models.js";
import { receiptPath } from "../../storage/capture/paths.js";
import type { ReconstructionJob } from "../reconstruction/models.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import type { LangSmithUploadWriterOptions, PreparedRunPostSubmission } from "../upload/models.js";
import { createTracingEngine } from "./engine.js";
import type {
  TracingEngineRecoveryRuntime,
  TracingEngineSession,
  TracingEngineSessionCallbacks,
  TracingEngineSessionOptions,
} from "./models.js";
import { recoverTracingSessions } from "./recovery.js";

const integration = "claude-code";
const writer: LangSmithUploadWriterOptions = {
  destinations: [
    {
      apiKey: "synthetic-session-recovery-key",
      apiUrl: "https://example.test/api/v1",
      projectName: "session-recovery-test",
    },
  ],
  redact: false,
};
const accountFingerprint = createLangSmithUploadWriter(writer).accountFingerprint;
const roots: string[] = [];
const children = new Set<ChildProcess>();

const childProgram = `
const fs = await import("node:fs");
const api = await import(process.argv[1]);
const { storageRoot, sessionId, writer, resultPath, reconstructOutput } = JSON.parse(process.argv[2]);
const engine = api.createTracingEngine({ storageRoot, integration: "claude-code", writer });
const session = engine.forSession({
  sessionId,
  resolveScope: (expected) => expected,
  scheduleWake: () => { throw new Error("unexpected nested worker launch"); },
  reconstruct: async (job) => {
    if (!reconstructOutput) return { status: "deferred", reason: "missing-thread-identity" };
    const runId = "33333333-3333-4333-8333-333333333333";
    return {
      status: "ready",
      outputs: [{
        eventId: "recovered-output",
        submission: {
          operation: "post",
          integration: "claude-code",
          privacyMode: "full",
          metadata: { integration: "claude-code", threadId: "recovered-thread", agentType: "root", runType: "root" },
          run: {
            id: runId,
            name: "recovered run",
            run_type: "chain",
            start_time: "2026-10-10T12:00:00.000Z",
            trace_id: runId,
            dotted_order: "20261010T120000000000Z" + runId,
            inputs: { source: job.eventId },
          },
        },
      }],
    };
  },
});
try {
  fs.writeFileSync(resultPath, await session.drain());
} catch (error) {
  fs.writeFileSync(resultPath, String(error));
  process.exitCode = 1;
}
`;

function createArea(): string {
  const root = mkdtempSync(join(tmpdir(), "plugins-base-session-recovery-"));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Timed out waiting for recovery worker state");
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  return child.exitCode;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child);
}

function recoveryPost(runId: string): PreparedRunPostSubmission {
  return {
    operation: "post",
    integration,
    privacyMode: "full",
    metadata: { integration, threadId: "recovery-thread", agentType: "root", runType: "root" },
    run: {
      id: runId,
      name: "recovery test run",
      run_type: "chain",
      start_time: "2026-10-10T12:00:00.000Z",
      trace_id: runId,
      dotted_order: `20261010T120000000000Z${runId}`,
      inputs: { source: runId },
    },
  };
}

function createPausedSessionOptions(
  sessionId: string,
  scheduleWake: TracingEngineSessionOptions["scheduleWake"],
  reconstruct: TracingEngineSessionOptions["reconstruct"] = async () => ({
    status: "deferred",
    reason: "missing-thread-identity",
  }),
): TracingEngineSessionOptions {
  return {
    sessionId,
    scheduleWake,
    reconstruct,
    resolveScope: (expected) => expected,
    startupWaitMs: 2_000,
  };
}

async function leaveLifecycleCapturePending(
  session: TracingEngineSession,
  runId: string,
): Promise<void> {
  await expect(
    session.capture({
      turnId: `turn-${runId}`,
      eventId: `event-${runId}`,
      submission: recoveryPost(runId),
      turnEvidence: { childRunIds: [], closureState: "open" },
    }),
  ).rejects.toThrow("pause worker");
}

function cleanupArea(root: string): void {
  const pending = [root];
  const directories = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(path);
        directories.push(path);
      } else {
        unlinkSync(path);
      }
    }
  }
  for (const directory of directories.toReversed()) rmdirSync(directory);
}

function createRuntime(root: string, currentSessionId = "current-session") {
  const createdSessions: string[] = [];
  const currentWakes: string[] = [];
  const runtime: TracingEngineRecoveryRuntime = {
    storageRoot: root,
    integration,
    accountFingerprint,
    writer,
    currentSessionId,
    wakeCurrent: async () => {
      currentWakes.push(currentSessionId);
      return "launched";
    },
    createSession(options) {
      createdSessions.push(options.sessionId);
      return { wake: async () => "queued" } as unknown as TracingEngineSession;
    },
  };
  return { runtime, createdSessions, currentWakes };
}

function sessionCallbacks(): TracingEngineSessionCallbacks {
  return {
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
    scheduleWake: async () => process.pid + 100_000,
    resolveScope: (expected) => expected,
    startupWaitMs: 2_000,
  };
}

async function captureEvent(
  root: string,
  sessionId: string,
  destinationFingerprint: string,
  eventKind = "run-post",
) {
  const input: CaptureInput = {
    integration,
    sessionId,
    turnId: "recovery-turn",
    eventId: `event-${sessionId}`,
    runId: `run-${sessionId}`,
    destinationFingerprint,
    eventKind,
    normalizedPayload: {},
    turnEvidence: {},
    metadataProvenance: {},
  };
  const result = await createCaptureStore(root).capture(input);
  if (result.status !== "published") throw new Error(`Capture failed: ${result.status}`);
  return result.record;
}

afterEach(async () => {
  for (const child of children) await stopChild(child);
  children.clear();
  for (const root of roots) cleanupArea(root);
  roots.length = 0;
});

it("reports callback failures and continues recovering other sessions", async () => {
  const root = createArea();
  await captureEvent(root, "failed-session", accountFingerprint);
  await captureEvent(root, "good-session", accountFingerprint);
  const { runtime, createdSessions, currentWakes } = createRuntime(root);

  const report = await recoverTracingSessions(runtime, {
    optionsForSession: (sessionId) => {
      if (sessionId === "failed-session") throw new Error("missing wake callback");
      return sessionCallbacks();
    },
    minimumForeignAgeMs: 0,
  });

  expect(createdSessions).toEqual(["good-session"]);
  expect(currentWakes).toEqual([]);
  expect(report).toEqual({
    scheduled: [{ sessionId: "good-session", status: "queued" }],
    failed: [{ sessionId: "failed-session", message: "missing wake callback" }],
  });
});

it("reports an unreadable receipt for one session and continues with healthy work", async () => {
  const root = createArea();
  const failedRecord = await captureEvent(root, "broken-session", accountFingerprint);
  await captureEvent(root, "healthy-session", accountFingerprint);
  const uploadWriter = createLangSmithUploadWriter(writer);
  const destinationId = uploadWriter.destinations[0]?.id;
  if (!destinationId) throw new Error("Recovery destination is missing");
  const scope = {
    integration: failedRecord.integration,
    sessionId: failedRecord.sessionId,
    turnId: failedRecord.turnId,
    eventId: failedRecord.eventId,
  };
  const store = createCaptureStore(root);
  await store.recordOutcome({ ...scope, destination: destinationId, outcome: "delivered" });
  writeFileSync(receiptPath(root, scope, destinationId), "{}");
  const { runtime, createdSessions, currentWakes } = createRuntime(root);

  const report = await recoverTracingSessions(runtime, {
    optionsForSession: () => sessionCallbacks(),
    minimumForeignAgeMs: 0,
  });

  expect(createdSessions).toEqual(["healthy-session"]);
  expect(currentWakes).toEqual([]);
  expect(report.scheduled).toEqual([{ sessionId: "healthy-session", status: "queued" }]);
  expect(report.failed).toHaveLength(1);
  expect(report.failed[0]?.sessionId).toBe("broken-session");
  expect(report.failed[0]?.message).toBe("Unsupported outcome receipt");
});

it("recovers stale current, foreign, and reconstruction work through localhost while preserving young and other-account captures", async () => {
  const root = createArea();
  const requests: Pick<IncomingMessage, "method" | "url">[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.on("data", () => {});
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local endpoint did not start");
  const localWriter: LangSmithUploadWriterOptions = {
    destinations: [
      {
        apiKey: "synthetic-session-recovery-local-key",
        apiUrl: `http://127.0.0.1:${address.port}/api/v1`,
        projectName: "session-recovery-local-test",
      },
    ],
    redact: false,
  };
  const engine = createTracingEngine({ storageRoot: root, integration, writer: localWriter });
  const recoveryNow = Date.now();
  const moduleUrl = pathToFileURL(resolve("dist/tracing/index.js")).href;
  const spawnWorker =
    (sessionId: string, reconstructOutput = false) =>
    () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          childProgram,
          moduleUrl,
          JSON.stringify({
            storageRoot: root,
            sessionId,
            writer: localWriter,
            resultPath: join(root, `worker-result-${sessionId}`),
            reconstructOutput,
          }),
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            TEMP: root,
            TMP: root,
            TMPDIR: root,
            CI: "1",
          },
          stdio: "ignore",
        },
      );
      children.add(child);
      return child.pid as number;
    };
  let currentWorkerReady = false;
  const currentSession = engine.forSession(
    createPausedSessionOptions("current-session", () => {
      if (!currentWorkerReady) throw new Error("pause worker");
      return spawnWorker("current-session")();
    }),
  );
  const staleSession = engine.forSession(
    createPausedSessionOptions("stale-session", () => {
      throw new Error("pause worker");
    }),
  );
  const youngSession = engine.forSession(
    createPausedSessionOptions("young-session", () => {
      throw new Error("pause worker");
    }),
  );
  const otherWriter: LangSmithUploadWriterOptions = {
    ...localWriter,
    destinations: [{ ...localWriter.destinations[0]!, apiKey: "synthetic-other-account-key" }],
  };
  const otherEngine = createTracingEngine({ storageRoot: root, integration, writer: otherWriter });
  const otherAccountSession = otherEngine.forSession(
    createPausedSessionOptions("other-account-session", () => {
      throw new Error("pause worker");
    }),
  );
  const otherAccountReconstructionSession = otherEngine.forSession(
    createPausedSessionOptions("other-account-reconstruction-session", () => {
      throw new Error("pause worker");
    }),
  );
  const reconstructionSession = engine.forSession(
    createPausedSessionOptions("reconstruction-only-session", () => {
      throw new Error("pause worker");
    }),
  );
  const dateNow = vi.spyOn(Date, "now");

  try {
    dateNow.mockReturnValue(recoveryNow - 120_000);
    await leaveLifecycleCapturePending(staleSession, "11111111-1111-4111-8111-111111111111");
    await expect(
      reconstructionSession.queueReconstruction({
        turnId: "reconstruction-turn",
        eventId: "reconstruction-job",
        sourceRefs: ["snapshot:reconstruction-job"],
        privacyMode: "full",
        turnEvidence: { childRunIds: [], closureState: "open" },
      }),
    ).rejects.toThrow("pause worker");
    dateNow.mockReturnValue(recoveryNow - 1_000);
    await leaveLifecycleCapturePending(youngSession, "22222222-2222-4222-8222-222222222222");
    dateNow.mockReturnValue(recoveryNow - 120_000);
    await leaveLifecycleCapturePending(otherAccountSession, "33333333-3333-4333-8333-333333333333");
    await expect(
      otherAccountReconstructionSession.queueReconstruction({
        turnId: "other-account-reconstruction-turn",
        eventId: "other-account-reconstruction-job",
        sourceRefs: ["snapshot:other-account-reconstruction-job"],
        privacyMode: "full",
        turnEvidence: { childRunIds: [], closureState: "open" },
      }),
    ).rejects.toThrow("pause worker");
    vi.restoreAllMocks();
    await leaveLifecycleCapturePending(currentSession, "55555555-5555-4555-8555-555555555555");
    currentWorkerReady = true;

    const callbackSessions: string[] = [];
    const report = await currentSession.recoverSessions({
      minimumForeignAgeMs: 60_000,
      now: recoveryNow,
      optionsForSession: (sessionId) => {
        callbackSessions.push(sessionId);
        return {
          ...sessionCallbacks(),
          reconstruct: async (job: ReconstructionJob) =>
            job.eventId === "reconstruction-job"
              ? {
                  status: "ready" as const,
                  outputs: [
                    {
                      eventId: "recovered-output",
                      submission: recoveryPost("44444444-4444-4444-8444-444444444444"),
                    },
                  ],
                }
              : { status: "deferred" as const, reason: "missing-thread-identity" as const },
          scheduleWake: spawnWorker(sessionId, sessionId === "reconstruction-only-session"),
        };
      },
    });

    expect(callbackSessions).toEqual(["reconstruction-only-session", "stale-session"]);
    expect(report).toEqual({
      scheduled: [
        { sessionId: "current-session", status: "launched" },
        { sessionId: "reconstruction-only-session", status: "launched" },
        { sessionId: "stale-session", status: "launched" },
      ],
      failed: [],
    });
    for (const child of children) await expect(waitForExit(child)).resolves.toBe(0);
    expect(readFileSync(join(root, "worker-result-current-session"), "utf8")).toBe("completed");
    expect(readFileSync(join(root, "worker-result-reconstruction-only-session"), "utf8")).toBe(
      "completed",
    );
    expect(readFileSync(join(root, "worker-result-stale-session"), "utf8")).toBe("completed");
    expect(requests).toHaveLength(3);
    expect(requests.map(({ method }) => method)).toEqual(["POST", "POST", "POST"]);
  } finally {
    vi.restoreAllMocks();
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
  }
});
