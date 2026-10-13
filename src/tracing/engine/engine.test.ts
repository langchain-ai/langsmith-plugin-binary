import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync,
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
import type { LocalRequest } from "../../test-support/models/lifecycle.js";
import type { TestArea } from "../../test-support/models/engine.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import type { LangSmithUploadWriterOptions, PreparedRunPostSubmission } from "../upload/models.js";
import { workerPendingPath } from "../background-worker/paths.js";
import { eventPath } from "../../storage/capture/paths.js";
import type { JsonValue } from "../../storage/capture/models.js";
import {
  RECONSTRUCTION_DIRECTORY,
  RECONSTRUCTION_MAPPING_KIND,
} from "../reconstruction/constants.js";
import type { LifecycleSnapshotCaptureInput } from "../lifecycle/models.js";
import { createTracingEngine } from "./engine.js";
import { CaptureWakeError } from "../index.js";
import type {
  TracingEngineOptions,
  TracingEngineScope,
  TracingEngineSessionOptions,
} from "./models.js";

const integration = "claude-code";
const sessionId = "engine-test-session";
const writer: LangSmithUploadWriterOptions = {
  destinations: [
    {
      apiKey: "synthetic-engine-test-key",
      apiUrl: "https://example.test/api/v1",
      projectName: "engine-test",
    },
  ],
  redact: false,
};

const childProgram = `
const fs = await import("node:fs");
const api = await import(process.argv[1]);
const { storageRoot, sessionId, writer, callPath, resultPath } = JSON.parse(process.argv[2]);
const engine = api.createTracingEngine({ storageRoot, integration: "claude-code", writer });
const session = engine.forSession({
  sessionId,
  resolveScope: (expected) => expected,
  scheduleWake: () => { throw new Error("unexpected nested worker launch"); },
  reconstruct: async () => {
    fs.writeFileSync(callPath, String(Number(fs.existsSync(callPath) ? fs.readFileSync(callPath, "utf8") : 0) + 1));
    return { status: "deferred", reason: "missing-thread-identity" };
  },
});
try {
  fs.writeFileSync(resultPath, await session.drain());
} catch (error) {
  fs.writeFileSync(resultPath, String(error));
  process.exitCode = 1;
}
`;

const areas: TestArea[] = [];

function createArea(): TestArea {
  const area = {
    root: mkdtempSync(join(tmpdir(), "plugins-base-engine-")),
    children: new Set<ChildProcess>(),
  };
  areas.push(area);
  return area;
}

function cleanupArea(root: string): void {
  const directories = [root];
  const orderedDirectories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        directories.push(path);
        orderedDirectories.push(path);
      } else {
        unlinkSync(path);
      }
    }
  }
  for (const directory of orderedDirectories.toReversed()) rmdirSync(directory);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Timed out waiting for engine worker state");
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

afterEach(async () => {
  for (const area of areas) {
    for (const child of area.children) await stopChild(child);
    cleanupArea(area.root);
  }
  areas.length = 0;
});

it("snapshots session callbacks and stops when the active account changes", async () => {
  const area = createArea();
  const mutableWriter: LangSmithUploadWriterOptions = {
    ...structuredClone(writer),
    replicas: [
      {
        apiKey: "synthetic-engine-replica-key",
        apiUrl: "https://replica.example.test/api/v1",
        projectName: "engine-replica-test",
        updates: { extra: { metadata: { marker: "original" } } },
      },
    ],
  };
  const expectedAccount = createLangSmithUploadWriter(mutableWriter).accountFingerprint;
  const engineOptions: TracingEngineOptions = {
    storageRoot: area.root,
    integration,
    writer: mutableWriter,
  };
  const engine = createTracingEngine(engineOptions);
  mutableWriter.destinations[0]!.projectName = "mutated-project";
  mutableWriter.replicas![0]!.updates!.extra = { metadata: { marker: "mutated" } };
  engineOptions.integration = "cursor";
  const expectedScope: TracingEngineScope = {
    integration,
    sessionId,
    accountFingerprint: expectedAccount,
  };
  let currentScope = expectedScope;
  const reconstruct = vi.fn(async () => ({
    status: "deferred" as const,
    reason: "missing-thread-identity" as const,
  }));
  const replacementReconstruct = vi.fn(async () => ({
    status: "deferred" as const,
    reason: "missing-thread-identity" as const,
  }));
  const launch = vi.fn(() => {
    throw new Error("injected worker startup failure");
  });
  const sessionOptions: TracingEngineSessionOptions = {
    sessionId,
    reconstruct,
    scheduleWake: launch,
    resolveScope: () => currentScope,
  };
  const session = engine.forSession(sessionOptions);
  sessionOptions.sessionId = "mutated-session";
  sessionOptions.reconstruct = replacementReconstruct;
  sessionOptions.scheduleWake = () => {
    throw new Error("replacement launcher must not be used");
  };
  sessionOptions.resolveScope = () => ({ ...expectedScope, accountFingerprint: "other-account" });

  const queued = session.queueReconstruction({
    turnId: "turn-1",
    eventId: "job-1",
    sourceRefs: ["snapshot:job-1"],
    privacyMode: "full",
    turnEvidence: { childRunIds: [], closureState: "authoritative" },
  });
  await expect(queued).rejects.toThrow("injected worker startup failure");
  await expect(queued).rejects.toBeInstanceOf(CaptureWakeError);
  await expect(queued).rejects.toMatchObject({
    captureResult: { status: "published", record: { eventId: "job-1" } },
  });
  expect(existsSync(workerPendingPath(area.root, expectedScope))).toBe(true);

  currentScope = { ...expectedScope, accountFingerprint: "other-account" };
  await expect(session.drain()).resolves.toBe("scope-mismatch");
  expect(reconstruct).not.toHaveBeenCalled();
  expect(existsSync(workerPendingPath(area.root, expectedScope))).toBe(true);

  currentScope = expectedScope;
  await expect(session.drain()).resolves.toBe("completed");
  expect(reconstruct).toHaveBeenCalledTimes(1);
  expect(replacementReconstruct).not.toHaveBeenCalled();
  expect(launch).toHaveBeenCalledTimes(1);
  expect(existsSync(workerPendingPath(area.root, expectedScope))).toBe(false);
});

it("distinguishes saved captures from invalid retries after a failed wake", async () => {
  const area = createArea();
  const failure = new Error("injected launcher failure");
  const session = createTracingEngine({ storageRoot: area.root, integration, writer }).forSession({
    sessionId,
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      throw failure;
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
  });
  const submission: PreparedRunPostSubmission = {
    operation: "post",
    integration,
    privacyMode: "full",
    metadata: { integration, threadId: sessionId, agentType: "root", runType: "root" },
    run: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "root",
      run_type: "chain",
      inputs: {},
    },
  };
  const input = {
    turnId: "turn-wake-result",
    eventId: "event-wake-result",
    submission,
    turnEvidence: { childRunIds: [], closureState: "open" as const },
  };
  for (const status of ["published", "duplicate"]) {
    const pending = session.capture(input);
    await expect(pending).rejects.toBeInstanceOf(CaptureWakeError);
    await expect(pending).rejects.toMatchObject({
      captureResult: { status, record: { eventId: input.eventId } },
      cause: failure,
    });
  }
  const invalid = session.capture({
    ...input,
    submission: { ...submission, run: { ...submission.run, name: "" } },
  });
  await expect(invalid).rejects.toBeInstanceOf(TypeError);
  await expect(invalid).rejects.not.toBeInstanceOf(CaptureWakeError);
});

it("verifies a saved reconstruction wake against the queued job", async () => {
  const area = createArea();
  const failure = new Error("injected launcher failure");
  const session = createTracingEngine({ storageRoot: area.root, integration, writer }).forSession({
    sessionId,
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      throw failure;
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
  });
  const input = {
    turnId: "turn-reconstruction-wake",
    eventId: "event-reconstruction-wake",
    sourceRefs: ["snapshot:reconstruction-wake"],
    privacyMode: "full" as const,
    turnEvidence: { childRunIds: [], closureState: "authoritative" as const },
  };
  let wakeError: unknown;
  try {
    await session.queueReconstruction(input);
  } catch (error) {
    wakeError = error;
  }
  expect(wakeError).toBeInstanceOf(CaptureWakeError);
  if (!(wakeError instanceof CaptureWakeError))
    throw new Error("Expected failed reconstruction wake");
  await expect(session.readSavedReconstructionWake(wakeError, input)).resolves.toEqual(
    wakeError.captureResult,
  );

  const alteredRecord = {
    ...wakeError.captureResult.record,
    eventKind: RECONSTRUCTION_MAPPING_KIND,
    normalizedPayload: {
      ...(wakeError.captureResult.record.normalizedPayload as Record<string, JsonValue>),
      sourceRefs: ["snapshot:altered-reconstruction-wake"],
    },
    turnEvidence: {
      ...(wakeError.captureResult.record.turnEvidence as Record<string, JsonValue>),
      childRunIds: ["altered-run"],
    },
  };
  const recordPath = eventPath(
    join(area.root, RECONSTRUCTION_DIRECTORY),
    wakeError.captureResult.record,
  );
  writeFileSync(recordPath, JSON.stringify(alteredRecord));
  const alteredWakeError = new CaptureWakeError(
    { ...wakeError.captureResult, record: alteredRecord },
    failure,
  );
  await expect(
    session.readSavedReconstructionWake(alteredWakeError, input),
  ).resolves.toBeUndefined();
  writeFileSync(recordPath, JSON.stringify(wakeError.captureResult.record));
  await expect(
    session.readSavedReconstructionWake(wakeError, {
      ...input,
      sourceRefs: ["snapshot:changed-reconstruction-wake"],
    }),
  ).resolves.toBeUndefined();
});

it("forwards session snapshots through the shared revision capture", async () => {
  const area = createArea();
  const failure = new Error("injected launcher failure");
  const session = createTracingEngine({ storageRoot: area.root, integration, writer }).forSession({
    sessionId,
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      throw failure;
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
  });
  const runId = "11111111-1111-4111-8111-111111111111";
  const input: LifecycleSnapshotCaptureInput = {
    turnId: "turn-engine-snapshot",
    eventId: "event-engine-snapshot",
    submission: {
      operation: "post" as const,
      integration,
      privacyMode: "full" as const,
      metadata: {
        integration,
        threadId: sessionId,
        agentType: "root" as const,
        runType: "root" as const,
      },
      run: {
        id: runId,
        name: "root",
        run_type: "chain",
        start_time: "2026-10-10T12:00:00.000Z",
        trace_id: runId,
        dotted_order: `20261010T120000000000Z${runId}`,
        inputs: {},
      },
    },
    turnEvidence: { rootRunId: runId, childRunIds: [], closureState: "open" as const },
  };
  const initial = session.captureSnapshot(input);
  await expect(initial).rejects.toMatchObject({
    captureResult: { status: "published", record: { eventKind: "run-post" } },
    cause: failure,
  });
  const revised = session.captureSnapshot({
    ...input,
    eventId: "event-engine-snapshot-update",
    submission: {
      ...input.submission,
      run: { ...input.submission.run, outputs: { answer: "done" } },
    },
  });
  await expect(revised).rejects.toMatchObject({
    captureResult: { status: "published", record: { eventKind: "run-patch" } },
    cause: failure,
  });
  await expect(
    createCaptureStore(area.root).enumerateTurn(integration, sessionId, input.turnId),
  ).resolves.toMatchObject([
    { record: { eventKind: "run-post" } },
    {
      record: {
        eventKind: "run-patch",
        normalizedPayload: { patch: { values: { outputs: { answer: "done" } } } },
      },
    },
  ]);
});

it("recovers a persisted reconstruction job after a later explicit wake", async () => {
  const area = createArea();
  const engine = createTracingEngine({ storageRoot: area.root, integration, writer });
  const scope: TracingEngineScope = {
    integration,
    sessionId,
    accountFingerprint: createLangSmithUploadWriter(writer).accountFingerprint,
  };
  let launchMode: "fail" | "child" = "fail";
  const moduleUrl = pathToFileURL(resolve("dist/tracing/index.js")).href;
  const session = engine.forSession({
    sessionId,
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      if (launchMode === "fail") throw new Error("worker not started");
      const child = spawn(
        process.execPath,
        [
          "-e",
          childProgram,
          moduleUrl,
          JSON.stringify({
            storageRoot: area.root,
            sessionId,
            writer,
            callPath: join(area.root, "reconstruct-calls"),
            resultPath: join(area.root, "worker-result"),
          }),
        ],
        {
          env: {
            HOME: area.root,
            USERPROFILE: area.root,
            TEMP: area.root,
            TMP: area.root,
            TMPDIR: area.root,
            CI: "1",
          },
          stdio: "ignore",
        },
      );
      area.children.add(child);
      return child.pid as number;
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
    startupWaitMs: 2_000,
  });

  await expect(
    session.queueReconstruction({
      turnId: "turn-1",
      eventId: "job-1",
      sourceRefs: ["snapshot:job-1"],
      privacyMode: "full",
      turnEvidence: { childRunIds: [], closureState: "authoritative" },
    }),
  ).rejects.toThrow("worker not started");
  expect(existsSync(workerPendingPath(area.root, scope))).toBe(true);

  launchMode = "child";
  await expect(session.wake()).resolves.toBe("launched");
  const child = [...area.children][0];
  expect(child).toBeDefined();
  await expect(waitForExit(child!)).resolves.toBe(0);
  expect(readFileSync(join(area.root, "reconstruct-calls"), "utf8")).toBe("1");
  expect(readFileSync(join(area.root, "worker-result"), "utf8")).toBe("completed");
  expect(existsSync(workerPendingPath(area.root, scope))).toBe(false);
});

it("finishes settlement after its wake is queued during the worker run", async () => {
  const area = createArea();
  const requests: LocalRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        payload: body === "" ? {} : JSON.parse(body),
      });
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
        apiKey: "synthetic-engine-settlement-key",
        apiUrl: `http://127.0.0.1:${address.port}/api/v1`,
        projectName: "engine-settlement-test",
      },
    ],
    redact: false,
  };
  const engine = createTracingEngine({ storageRoot: area.root, integration, writer: localWriter });
  const scope: TracingEngineScope = {
    integration,
    sessionId,
    accountFingerprint: createLangSmithUploadWriter(localWriter).accountFingerprint,
  };
  let launchMode: "fail" | "child" = "fail";
  const moduleUrl = pathToFileURL(resolve("dist/tracing/index.js")).href;
  const session = engine.forSession({
    sessionId,
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      if (launchMode === "fail") throw new Error("worker startup failure");
      const childProcess = spawn(
        process.execPath,
        [
          "-e",
          childProgram,
          moduleUrl,
          JSON.stringify({
            storageRoot: area.root,
            sessionId,
            writer: localWriter,
            callPath: join(area.root, "reconstruct-calls"),
            resultPath: join(area.root, "worker-result"),
          }),
        ],
        {
          env: {
            HOME: area.root,
            USERPROFILE: area.root,
            TEMP: area.root,
            TMP: area.root,
            TMPDIR: area.root,
            CI: "1",
          },
          stdio: "ignore",
        },
      );
      area.children.add(childProcess);
      return childProcess.pid as number;
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
    startupWaitMs: 2_000,
  });
  const rootId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const rootOrder = `20261010T120000000000Z${rootId}`;
  const childOrder = `${rootOrder}.20261010T120000001000Z${childId}`;
  const evidence = {
    rootRunId: rootId,
    childRunIds: [childId],
    closureState: "authoritative" as const,
  };
  const root: PreparedRunPostSubmission = {
    operation: "post",
    integration,
    privacyMode: "full",
    metadata: {
      integration,
      threadId: "thread-1",
      agentType: "root",
      runType: "root",
      base: {
        repository_name: "acme/project",
        repository_provider: "github",
        repository_url: "https://github.com/acme/project",
        git_branch: "main",
        git_commit_sha: "abc123",
      },
    },
    run: {
      id: rootId,
      name: "root run",
      run_type: "chain",
      start_time: "2026-10-10T12:00:00.000Z",
      end_time: "2026-10-10T12:00:01.000Z",
      trace_id: rootId,
      dotted_order: rootOrder,
      inputs: {},
    },
  };
  const child: PreparedRunPostSubmission = {
    operation: "post",
    integration,
    privacyMode: "full",
    metadata: { integration, threadId: "thread-1", agentType: "subagent", runType: "tool" },
    run: {
      id: childId,
      name: "child run",
      run_type: "tool",
      start_time: "2026-10-10T12:00:00.001Z",
      end_time: "2026-10-10T12:00:02.000Z",
      parent_run_id: rootId,
      trace_id: rootId,
      dotted_order: childOrder,
      inputs: {},
    },
  };

  try {
    await expect(
      session.captureSnapshot({
        turnId: "turn-1",
        eventId: "event-root",
        submission: root,
        turnEvidence: evidence,
      }),
    ).rejects.toThrow("worker startup failure");
    await expect(
      session.capture({
        turnId: "turn-1",
        eventId: "event-child",
        submission: child,
        turnEvidence: evidence,
        dependencies: [{ integration, sessionId, turnId: "turn-1", eventId: "event-root" }],
      }),
    ).rejects.toThrow("worker startup failure");

    launchMode = "child";
    await expect(session.wake()).resolves.toBe("launched");
    const childProcess = [...area.children][0];
    expect(childProcess).toBeDefined();
    await expect(waitForExit(childProcess!)).resolves.toBe(0);
    expect(readFileSync(join(area.root, "worker-result"), "utf8")).toBe("completed");
    expect(requests).toHaveLength(4);
    expect(requests.map(({ method }) => method)).toEqual(["POST", "POST", "PATCH", "PATCH"]);
    expect(requests.slice(0, 2).every(({ payload }) => payload["end_time"] === undefined)).toBe(
      true,
    );
    expect(
      requests.slice(2).map(({ path, payload }) => ({ path, endTime: payload["end_time"] })),
    ).toEqual(
      expect.arrayContaining([
        { path: `/api/v1/runs/${rootId}`, endTime: root.run.end_time },
        { path: `/api/v1/runs/${childId}`, endTime: child.run.end_time },
      ]),
    );
    expect(existsSync(workerPendingPath(area.root, scope))).toBe(false);
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
  }
});
