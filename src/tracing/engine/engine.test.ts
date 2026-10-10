import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalRequest } from "../../test-support/models/lifecycle.js";
import type { TestArea } from "../../test-support/models/engine.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import type { LangSmithUploadWriterOptions, PreparedRunPostSubmission } from "../upload/models.js";
import { workerPendingPath } from "../background-worker/paths.js";
import { createTracingEngine } from "./engine.js";
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
  const mutableWriter = structuredClone(writer);
  const expectedAccount = createLangSmithUploadWriter(mutableWriter).accountFingerprint;
  const engineOptions: TracingEngineOptions = {
    storageRoot: area.root,
    integration,
    writer: mutableWriter,
  };
  const engine = createTracingEngine(engineOptions);
  mutableWriter.destinations[0]!.projectName = "mutated-project";
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

  await expect(
    session.queueReconstruction({
      turnId: "turn-1",
      eventId: "job-1",
      sourceRefs: ["snapshot:job-1"],
      privacyMode: "full",
      turnEvidence: { childRunIds: [], closureState: "authoritative" },
    }),
  ).rejects.toThrow("injected worker startup failure");
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
  const requests: Pick<LocalRequest, "method" | "path">[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", path: request.url ?? "" });
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
      session.capture({
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
    expect(requests).toHaveLength(3);
    expect(requests.map(({ method }) => method)).toEqual(["POST", "POST", "PATCH"]);
    expect(existsSync(workerPendingPath(area.root, scope))).toBe(false);
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
  }
});
