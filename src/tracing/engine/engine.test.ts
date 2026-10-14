import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import { childEnvironment, moduleUrl, temporaryRoot } from "../../test-support/tracing/delivery.js";
import {
  CHILD_ID,
  ROOT_ID,
  captureScope,
  localEndpoint,
  runPost,
  turnEvidence,
  writerFor,
} from "../../test-support/tracing/lifecycle.js";
import { workerPendingPath } from "../background-worker/paths.js";
import { CaptureWakeError } from "../index.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import { TRACING_ENGINE_STORAGE_ROOT_REQUIRED_MESSAGE } from "./constants.js";
import { createTracingEngine } from "./engine.js";
import type {
  TracingEngineOptions,
  TracingEngineScope,
  TracingEngineSessionOptions,
} from "./models.js";

const deferred = async () => ({ status: "deferred", reason: "missing-thread-identity" }) as const;
const children: ChildProcess[] = [];
const job = {
  turnId: "turn",
  eventId: "job",
  sourceRefs: ["source"],
  privacyMode: "full",
  turnEvidence: { childRunIds: [], closureState: "authoritative" },
} as const;

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function session(
  root: string,
  options: Partial<TracingEngineSessionOptions> = {},
  engine: Partial<TracingEngineOptions> = {},
) {
  return createTracingEngine({
    storageRoot: root,
    integration: "claude-code",
    writer: writerFor("http://127.0.0.1:1/api/v1"),
    ...engine,
  }).forSession({
    sessionId: "session-1",
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      throw new Error("launch failed");
    },
    reconstruct: deferred,
    ...options,
  });
}

it("rejects a blank storage folder instead of using the current folder", () => {
  expect(() => session("")).toThrow(TRACING_ENGINE_STORAGE_ROOT_REQUIRED_MESSAGE);
});

function snapshotSetup() {
  const root = temporaryRoot();
  const writer = {
    ...writerFor("http://127.0.0.1:1/api/v1"),
    replicas: [{ projectName: "replica", updates: { extra: { marker: "original" } } }],
  };
  const scope: TracingEngineScope = {
    integration: "claude-code",
    sessionId: "session-1",
    accountFingerprint: createLangSmithUploadWriter(writer).accountFingerprint,
  };
  const state = { current: scope };
  const reconstruct = vi.fn(deferred);
  const launch = vi.fn(() => {
    throw new Error("injected launch failure");
  });
  const options: TracingEngineSessionOptions = {
    sessionId: "session-1",
    resolveScope: () => state.current,
    scheduleWake: launch,
    reconstruct,
  };
  const engineOptions = { storageRoot: root, integration: "claude-code" as const, writer };
  const engine = createTracingEngine(engineOptions);
  writer.destinations[0]!.projectName = "mutated";
  writer.replicas[0]!.updates.extra.marker = "mutated";
  engineOptions.integration = "cursor" as never;
  const tracing = engine.forSession(options);
  Object.assign(options, {
    sessionId: "mutated",
    reconstruct: vi.fn(),
    scheduleWake: () => {
      throw new Error("launch failed");
    },
  });
  return { root, scope, state, reconstruct, launch, tracing };
}

it("keeps using the options it was created with after they are changed", async () => {
  const { root, scope, reconstruct, launch, tracing } = snapshotSetup();
  await expect(tracing.queueReconstruction(job)).rejects.toThrow("injected launch failure");
  expect(existsSync(workerPendingPath(root, scope))).toBe(true);
  await expect(tracing.drain()).resolves.toBe("completed");
  expect(reconstruct).toHaveBeenCalledTimes(1);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(existsSync(workerPendingPath(root, scope))).toBe(false);
});

it("stops draining once the account changes", async () => {
  const { scope, state, reconstruct, tracing } = snapshotSetup();
  await expect(tracing.queueReconstruction(job)).rejects.toThrow("injected launch failure");
  state.current = { ...scope, accountFingerprint: "other-account" };
  await expect(tracing.drain()).resolves.toBe("scope-mismatch");
  expect(reconstruct).not.toHaveBeenCalled();
});

it("separates saved captures from rejected input after a failed wake", async () => {
  const root = temporaryRoot();
  const tracing = session(root);
  const input = {
    turnId: "turn",
    eventId: "event",
    submission: runPost("root"),
    turnEvidence: turnEvidence("open", []),
  };
  for (const status of ["published", "duplicate"])
    await expect(tracing.capture(input)).rejects.toMatchObject({
      captureResult: { status },
      cause: new Error("launch failed"),
    });
  await expect(
    tracing.capture({ ...input, submission: runPost("root", { run: { name: "" } }) }),
  ).rejects.not.toBeInstanceOf(CaptureWakeError);
  const error = await tracing.queueReconstruction(job).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(CaptureWakeError);
  await expect(tracing.readSavedReconstructionWake(error, job)).resolves.toEqual(
    (error as CaptureWakeError).captureResult,
  );
});

it("recovers queued work in child workers that finish settlement", async () => {
  const root = temporaryRoot();
  const endpoint = await localEndpoint();
  const writer = writerFor(endpoint.url);
  const output = runPost("child", {
    run: {
      parent_run_id: undefined,
      dotted_order: undefined,
      trace_id: undefined,
      start_time: "2026-10-10T12:00:02.000Z",
    },
  });
  const launch = (sessionId: string) => () => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/engine-worker.mjs", import.meta.url)),
        moduleUrl("dist/tracing/index.js"),
        JSON.stringify({ root, sessionId, writer }),
        JSON.stringify(output),
      ],
      { env: childEnvironment(temporaryRoot()), stdio: "ignore" },
    );
    children.push(child);
    return child.pid!;
  };
  const paused = (sessionId: string) =>
    session(root, { sessionId, startupWaitMs: 8_000 }, { writer });
  const end = { run: { end_time: "2026-10-10T12:00:01.000Z" } };
  const current = paused("session-1");
  await current
    .capture({
      turnId: "turn",
      eventId: "root",
      submission: runPost("root", end),
      turnEvidence: turnEvidence(),
    })
    .catch(() => {});
  const scope = captureScope("session-1", "turn", "root");
  await current
    .capture({
      turnId: "turn",
      eventId: "child",
      submission: runPost("child", end),
      turnEvidence: turnEvidence(),
      dependencies: [scope],
    })
    .catch(() => {});
  await paused("foreign")
    .queueReconstruction(job)
    .catch(() => {});
  const recovering = session(
    root,
    { scheduleWake: launch("session-1"), startupWaitMs: 8_000 },
    { writer },
  );
  const report = await recovering.recoverSessions({
    minimumForeignAgeMs: 0,
    optionsForSession: (sessionId) => ({
      resolveScope: (expected) => expected,
      reconstruct: deferred,
      scheduleWake: launch(sessionId),
      startupWaitMs: 8_000,
    }),
  });
  expect(report.failed).toEqual([]);
  expect(report.scheduled).toHaveLength(2);
  expect(report.scheduled).toEqual(
    expect.arrayContaining([
      { sessionId: "foreign", status: "launched" },
      { sessionId: "session-1", status: "launched" },
    ]),
  );
  await vi.waitFor(
    () =>
      expect(
        existsSync(join(root, "result-foreign")) && existsSync(join(root, "result-session-1")),
      ).toBe(true),
    { timeout: 8_000 },
  );
  expect(
    ["foreign", "session-1"].map((id) => readFileSync(join(root, `result-${id}`), "utf8")),
  ).toEqual(["completed", "completed"]);
  expect(
    endpoint.requests.map(({ method, path }) => `${method} ${path.split("/").at(-1)}`).toSorted(),
  ).toEqual(
    ["PATCH " + CHILD_ID, "PATCH " + ROOT_ID, "POST runs", "POST runs", "POST runs"].toSorted(),
  );
  await expect(createCaptureStore(root).enumerate("claude-code", "foreign")).resolves.toHaveLength(
    1,
  );
  await endpoint.close();
}, 20_000);

it("reports background recovery after a drain without failing the drain", async () => {
  const root = temporaryRoot();
  const reports: unknown[] = [];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  let checks = 0;
  const recovery = (
    onReport: (report: unknown) => void,
    resolveChecks = Number.POSITIVE_INFINITY,
    storageRoot = root,
  ) =>
    session(storageRoot, {
      resolveScope: (expected) =>
        ++checks <= resolveChecks ? expected : { ...expected, accountFingerprint: "new" },
      backgroundRecovery: {
        onReport,
        optionsForSession: () => Promise.reject(new Error("unused")),
      },
    });
  await expect(
    recovery((report) => {
      reports.push(report);
      throw new Error("report failed");
    }).drain(),
  ).resolves.toBe("idle");
  expect(reports).toMatchObject([{ status: "completed", report: { scheduled: [], failed: [] } }]);
  expect(error).toHaveBeenCalledWith("Background recovery report callback failed", "report failed");
  await expect(
    recovery((report) => {
      reports.push(report);
    }).drain(),
  ).resolves.toBe("idle");
  expect(reports[1]).toMatchObject({ status: "completed" });
  checks = 0;
  const otherRoot = temporaryRoot();
  const changed = recovery(
    (report) => {
      reports.push(report);
    },
    2,
    otherRoot,
  );
  await expect(changed.drain()).resolves.toBe("idle");
  expect(reports[2]).toEqual({ status: "scope-mismatch" });
  error.mockRestore();
});
