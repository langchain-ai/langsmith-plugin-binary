import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createLangSmithUploadWriter } from "../upload/index.js";
import type { LangSmithUploadWriterOptions, PreparedRunPostSubmission } from "../upload/models.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import { FILE_LOCK_DIRECTORY_SUFFIX } from "../../storage/constants.js";
import { CaptureWakeError } from "../capture-wake.js";
import { withFileLock } from "../../storage/file-lock.js";
import { createTracingEngine } from "./engine.js";
import { recoverTracingSessions } from "./recovery.js";
import { backgroundRecoveryPaths } from "./recovery-paths.js";
import type { TracingEngineRecoveryRuntime } from "./models.js";

const integration = "claude-code";
const processes = new Set<ChildProcess>();
const servers = new Set<ReturnType<typeof createServer>>();

const childProgram = `
const fs = await import("node:fs");
const api = await import(process.argv[1]);
const { storageRoot, sessionId, writer, scanPath, reportPath, resultPath, readyPath, delayMs, cooldownMs, throwReportError } = JSON.parse(process.argv[2]);
const engine = api.createTracingEngine({ storageRoot, integration: "claude-code", writer });
const session = engine.forSession({
  sessionId,
  resolveScope: (expected) => expected,
  scheduleWake: () => { throw new Error("unexpected recovered-session launch"); },
  reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
  backgroundRecovery: {
    minimumForeignAgeMs: 0,
    cooldownMs,
    optionsForSession: async (recoveredSessionId) => {
      fs.appendFileSync(scanPath, recoveredSessionId + "\\n");
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      throw new Error("synthetic adapter context unavailable");
    },
    onReport: (report) => {
      fs.writeFileSync(reportPath, JSON.stringify(report));
      if (throwReportError) throw new Error("synthetic reporting callback failed");
    },
  },
});
try {
  if (readyPath) fs.writeFileSync(readyPath, "ready");
  fs.writeFileSync(resultPath, await session.drain());
} catch (error) {
  fs.writeFileSync(resultPath, String(error.stack ?? error));
  console.error(error);
  process.exitCode = 1;
}
`;

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "plugins-base-background-recovery-"));
}

async function createLocalWriter(): Promise<{
  writer: LangSmithUploadWriterOptions;
  requests: Array<{ method: string | undefined; url: string | undefined }>;
}> {
  const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.on("data", () => {});
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  servers.add(server);
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local endpoint did not start");
  return {
    writer: {
      destinations: [
        {
          apiKey: "synthetic-background-recovery-key",
          apiUrl: `http://127.0.0.1:${address.port}/api/v1`,
          projectName: "background-recovery-test",
        },
      ],
      redact: false,
    },
    requests,
  };
}

function writerWithKey(writer: LangSmithUploadWriterOptions, apiKey: string) {
  return {
    ...writer,
    destinations: writer.destinations.map((destination) => ({ ...destination, apiKey })),
  };
}

function runPost(runId: string): PreparedRunPostSubmission {
  return {
    operation: "post",
    integration,
    privacyMode: "full",
    metadata: {
      integration,
      threadId: "background-recovery-test",
      agentType: "root",
      runType: "root",
    },
    run: {
      id: runId,
      name: "background recovery test",
      run_type: "chain",
      start_time: "2026-10-10T12:00:00.000Z",
      trace_id: runId,
      dotted_order: `20261010T120000000000Z${runId}`,
      inputs: {},
    },
  };
}

async function capturePendingSession(
  storageRoot: string,
  sessionId: string,
  writer: LangSmithUploadWriterOptions,
): Promise<void> {
  const engine = createTracingEngine({ storageRoot, integration, writer });
  const session = engine.forSession({
    sessionId,
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      throw new Error("pause worker");
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
  });
  try {
    await session.capture({
      turnId: `turn-${sessionId}`,
      eventId: `event-${sessionId}`,
      submission: runPost("11111111-1111-4111-8111-111111111111"),
      turnEvidence: { childRunIds: [], closureState: "open" },
    });
    throw new Error("The synthetic worker launcher unexpectedly succeeded");
  } catch (error) {
    if (!(error instanceof CaptureWakeError)) throw error;
    if (error.captureResult.status !== "published")
      throw new Error(`Could not seed pending capture: ${error.captureResult.status}`, {
        cause: error,
      });
  }
}

function launchWorker(options: {
  storageRoot: string;
  sessionId: string;
  writer: LangSmithUploadWriterOptions;
  scanPath: string;
  reportPath: string;
  resultPath: string;
  readyPath?: string;
  delayMs?: number;
  cooldownMs?: number;
  throwReportError?: boolean;
}): ChildProcess {
  const moduleUrl = pathToFileURL(resolve("dist/tracing/index.js")).href;
  const child = spawn(process.execPath, ["-e", childProgram, moduleUrl, JSON.stringify(options)], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: options.storageRoot,
      USERPROFILE: options.storageRoot,
      TEMP: options.storageRoot,
      TMP: options.storageRoot,
      TMPDIR: options.storageRoot,
      CI: "1",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  processes.add(child);
  return child;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Timed out waiting for background recovery proof");
}

async function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Background recovery worker timed out")),
      timeoutMs,
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolvePromise(code);
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await waitForExit(child);
  processes.delete(child);
}

afterEach(async () => {
  for (const child of processes) await stopChild(child);
  for (const server of servers) {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
    servers.delete(server);
  }
});

it("serializes concurrent account scans and keeps delivery successful when recovery reports a failure", async () => {
  const storageRoot = createRoot();
  const { writer, requests } = await createLocalWriter();
  await capturePendingSession(storageRoot, "worker-a", writer);
  await capturePendingSession(storageRoot, "foreign-session", writer);
  const scanPath = join(storageRoot, "scan.log");
  const first = launchWorker({
    storageRoot,
    sessionId: "worker-a",
    writer,
    scanPath,
    reportPath: join(storageRoot, "report-a.json"),
    resultPath: join(storageRoot, "result-a"),
    throwReportError: true,
    delayMs: 300,
    cooldownMs: 60_000,
  });
  await waitFor(() => existsSync(scanPath));
  const second = launchWorker({
    storageRoot,
    sessionId: "worker-b",
    writer,
    scanPath,
    reportPath: join(storageRoot, "report-b.json"),
    resultPath: join(storageRoot, "result-b"),
  });

  await expect(waitForExit(first)).resolves.toBe(0);
  await expect(waitForExit(second)).resolves.toBe(0);
  expect(readFileSync(scanPath, "utf8")).toBe("foreign-session\n");
  expect(readFileSync(join(storageRoot, "result-a"), "utf8")).toBe("completed");
  expect(readFileSync(join(storageRoot, "result-b"), "utf8")).toBe("idle");
  expect(JSON.parse(readFileSync(join(storageRoot, "report-a.json"), "utf8"))).toMatchObject({
    status: "partial",
    retryable: true,
    report: {
      failed: [{ sessionId: "foreign-session", message: "synthetic adapter context unavailable" }],
    },
  });
  expect(JSON.parse(readFileSync(join(storageRoot, "report-b.json"), "utf8"))).toMatchObject({
    status: "cooldown",
  });
  expect(requests.some(({ method }) => method === "POST")).toBe(true);
});

it("waits for the account scan lock before entering recovery", async () => {
  const storageRoot = createRoot();
  const { writer } = await createLocalWriter();
  await capturePendingSession(storageRoot, "foreign-session", writer);
  const paths = backgroundRecoveryPaths(storageRoot, {
    integration,
    accountFingerprint: createLangSmithUploadWriter(writer).accountFingerprint,
  });
  const lockReadyPath = join(storageRoot, "lock-ready");
  const releaseLockPath = join(storageRoot, "release-lock");
  const heldLock = withFileLock(paths.lock, async () => {
    writeFileSync(lockReadyPath, "ready");
    await waitFor(() => existsSync(releaseLockPath));
  });
  const scanPath = join(storageRoot, "scan.log");
  const readyPath = join(storageRoot, "ready");
  let child: ChildProcess | undefined;
  try {
    await waitFor(() => existsSync(lockReadyPath));
    child = launchWorker({
      storageRoot,
      sessionId: "worker-waiting",
      writer,
      scanPath,
      reportPath: join(storageRoot, "report.json"),
      resultPath: join(storageRoot, "result"),
      readyPath,
    });
    await waitFor(() => existsSync(readyPath));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    expect(existsSync(scanPath)).toBe(false);
  } finally {
    writeFileSync(releaseLockPath, "release");
    await heldLock;
  }
  if (!child) throw new Error("Background recovery worker was not started");
  await expect(waitForExit(child)).resolves.toBe(0);
  expect(readFileSync(scanPath, "utf8")).toBe("foreign-session\n");
});

it("rechecks the active scope after waiting for the account scan lock", async () => {
  const storageRoot = createRoot();
  const { writer } = await createLocalWriter();
  await capturePendingSession(storageRoot, "foreign-session", writer);
  const accountFingerprint = createLangSmithUploadWriter(writer).accountFingerprint;
  let currentScope = { integration, sessionId: "scope-waiting", accountFingerprint };
  const reports: unknown[] = [];
  const scans: string[] = [];
  const session = createTracingEngine({ storageRoot, integration, writer }).forSession({
    sessionId: currentScope.sessionId,
    resolveScope: () => currentScope,
    scheduleWake: () => {
      throw new Error("Unexpected worker launch");
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
    backgroundRecovery: {
      minimumForeignAgeMs: 0,
      onReport: (report) => {
        reports.push(report);
      },
      optionsForSession: (sessionId) => {
        scans.push(sessionId);
        return {
          resolveScope: () => currentScope,
          scheduleWake: () => {
            throw new Error("Unexpected recovered-session launch");
          },
          reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
        };
      },
    },
  });
  const paths = backgroundRecoveryPaths(storageRoot, currentScope);
  let signalLockReady!: () => void;
  let releaseLock!: () => void;
  const lockReady = new Promise<void>((resolvePromise) => {
    signalLockReady = resolvePromise;
  });
  const lockGate = new Promise<void>((resolvePromise) => {
    releaseLock = resolvePromise;
  });
  const heldLock = withFileLock(paths.lock, async () => {
    signalLockReady();
    await lockGate;
  });
  await lockReady;
  const drain = session.drain();
  const claimsDirectory = `${paths.lock}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  let waiterObserved = false;
  try {
    await waitFor(
      () => readdirSync(claimsDirectory).filter((name) => name.endsWith(".json")).length >= 2,
    );
    waiterObserved = true;
    currentScope = { ...currentScope, accountFingerprint: "changed-account" };
  } finally {
    releaseLock();
    await heldLock;
    if (!waiterObserved) await drain;
  }

  expect(waiterObserved).toBe(true);
  await expect(drain).resolves.toBe("idle");
  expect(reports).toEqual([{ status: "scope-mismatch" }]);
  expect(scans).toEqual([]);
});

it("rechecks the active scope after adapter options resolve", async () => {
  const storageRoot = createRoot();
  const { writer } = await createLocalWriter();
  await capturePendingSession(storageRoot, "foreign-session", writer);
  const accountFingerprint = createLangSmithUploadWriter(writer).accountFingerprint;
  let currentScope = { integration, sessionId: "scope-lookup", accountFingerprint };
  const reports: unknown[] = [];
  const recoveryOptionsCalls: string[] = [];
  const recoveryWakeCalls: string[] = [];
  let optionsStarted = false;
  let releaseOptions!: () => void;
  const optionsGate = new Promise<void>((resolvePromise) => {
    releaseOptions = resolvePromise;
  });
  const session = createTracingEngine({ storageRoot, integration, writer }).forSession({
    sessionId: currentScope.sessionId,
    resolveScope: () => currentScope,
    scheduleWake: () => {
      throw new Error("Unexpected current-session launch");
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
    backgroundRecovery: {
      minimumForeignAgeMs: 0,
      onReport: (report) => {
        reports.push(report);
      },
      optionsForSession: async (sessionId) => {
        recoveryOptionsCalls.push(sessionId);
        optionsStarted = true;
        await optionsGate;
        return {
          resolveScope: () => currentScope,
          scheduleWake: () => {
            recoveryWakeCalls.push(sessionId);
            throw new Error("Stale account launch");
          },
          reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
        };
      },
    },
  });
  const drain = session.drain();
  try {
    await waitFor(() => optionsStarted);
    currentScope = { ...currentScope, accountFingerprint: "changed-account" };
  } finally {
    releaseOptions();
    if (!optionsStarted) await drain;
  }

  expect(optionsStarted).toBe(true);
  await expect(drain).resolves.toBe("idle");
  expect(recoveryOptionsCalls).toEqual(["foreign-session"]);
  expect(recoveryWakeCalls).toEqual([]);
  expect(reports).toEqual([{ status: "scope-mismatch" }]);
});

it("stops recovery when the active scope cannot be resolved", async () => {
  const storageRoot = createRoot();
  const { writer } = await createLocalWriter();
  await capturePendingSession(storageRoot, "foreign-a", writer);
  await capturePendingSession(storageRoot, "foreign-b", writer);
  const accountFingerprint = createLangSmithUploadWriter(writer).accountFingerprint;
  const currentScope = { integration, sessionId: "scope-error", accountFingerprint };
  let failScopeLookup = false;
  const reports: unknown[] = [];
  const optionsCalls: string[] = [];
  const wakeCalls: string[] = [];
  const session = createTracingEngine({ storageRoot, integration, writer }).forSession({
    sessionId: currentScope.sessionId,
    resolveScope: () => {
      if (failScopeLookup) throw new Error("Synthetic scope resolver failure");
      return currentScope;
    },
    scheduleWake: () => {
      throw new Error("Unexpected current-session launch");
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
    backgroundRecovery: {
      minimumForeignAgeMs: 0,
      onReport: (report) => {
        reports.push(report);
      },
      optionsForSession: (sessionId) => {
        optionsCalls.push(sessionId);
        failScopeLookup = true;
        return {
          resolveScope: () => currentScope,
          scheduleWake: () => {
            wakeCalls.push(sessionId);
            throw new Error("Unexpected recovered-session launch");
          },
          reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
        };
      },
    },
  });

  await expect(session.drain()).resolves.toBe("idle");
  expect(optionsCalls).toEqual(["foreign-a"]);
  expect(wakeCalls).toEqual([]);
  expect(reports[0]).toMatchObject({
    status: "failed",
    message: "Synthetic scope resolver failure",
    retryable: true,
  });
});

it("keeps recovery cooldowns separate by account and retries after an expired marker", async () => {
  const storageRoot = createRoot();
  const { writer } = await createLocalWriter();
  const otherWriter = writerWithKey(writer, "synthetic-other-background-recovery-key");
  await capturePendingSession(storageRoot, "foreign-a", writer);
  await capturePendingSession(storageRoot, "foreign-b", otherWriter);
  const scanA = join(storageRoot, "scan-a.log");
  const scanB = join(storageRoot, "scan-b.log");
  const first = launchWorker({
    storageRoot,
    sessionId: "worker-a",
    writer,
    scanPath: scanA,
    reportPath: join(storageRoot, "report-a.json"),
    resultPath: join(storageRoot, "result-a"),
  });
  await expect(waitForExit(first)).resolves.toBe(0);
  const second = launchWorker({
    storageRoot,
    sessionId: "worker-b",
    writer: otherWriter,
    scanPath: scanB,
    reportPath: join(storageRoot, "report-b.json"),
    resultPath: join(storageRoot, "result-b"),
  });
  await expect(waitForExit(second)).resolves.toBe(0);
  expect(readFileSync(scanA, "utf8")).toBe("foreign-a\n");
  expect(readFileSync(scanB, "utf8")).toBe("foreign-b\n");

  const marker = backgroundRecoveryPaths(storageRoot, {
    integration,
    accountFingerprint: createLangSmithUploadWriter(writer).accountFingerprint,
  }).marker;
  writeFileSync(marker, JSON.stringify({ version: 1, retryAtMs: 0 }));
  const retry = launchWorker({
    storageRoot,
    sessionId: "worker-a-retry",
    writer,
    scanPath: scanA,
    reportPath: join(storageRoot, "report-a-retry.json"),
    resultPath: join(storageRoot, "result-a-retry"),
  });
  await expect(waitForExit(retry)).resolves.toBe(0);
  expect(readFileSync(scanA, "utf8")).toBe("foreign-a\nforeign-a\n");
  expect(JSON.parse(readFileSync(join(storageRoot, "report-a-retry.json"), "utf8"))).toMatchObject({
    status: "partial",
  });
});

it("reclaims a crashed scanner lock and retries after its persisted cooldown expires", async () => {
  const storageRoot = createRoot();
  const { writer } = await createLocalWriter();
  await capturePendingSession(storageRoot, "foreign-session", writer);
  const scanPath = join(storageRoot, "scan.log");
  const crashed = launchWorker({
    storageRoot,
    sessionId: "worker-before-crash",
    writer,
    scanPath,
    reportPath: join(storageRoot, "report-crashed.json"),
    resultPath: join(storageRoot, "result-crashed"),
    delayMs: 10_000,
  });
  await waitFor(() => existsSync(scanPath));
  const marker = backgroundRecoveryPaths(storageRoot, {
    integration,
    accountFingerprint: createLangSmithUploadWriter(writer).accountFingerprint,
  }).marker;
  expect(existsSync(marker)).toBe(true);
  await stopChild(crashed);
  writeFileSync(marker, JSON.stringify({ version: 1, retryAtMs: 0 }));

  const retry = launchWorker({
    storageRoot,
    sessionId: "worker-after-crash",
    writer,
    scanPath,
    reportPath: join(storageRoot, "report-retry.json"),
    resultPath: join(storageRoot, "result-retry"),
  });
  await expect(waitForExit(retry)).resolves.toBe(0);
  expect(readFileSync(scanPath, "utf8")).toBe("foreign-session\nforeign-session\n");
  expect(JSON.parse(readFileSync(join(storageRoot, "report-retry.json"), "utf8"))).toMatchObject({
    status: "partial",
  });
});

it("excludes the current session so recovery cannot queue a wake after its final drain check", async () => {
  const storageRoot = createRoot();
  const { writer } = await createLocalWriter();
  await capturePendingSession(storageRoot, "current-session", writer);
  const currentWakes: string[] = [];
  const runtime: TracingEngineRecoveryRuntime = {
    storageRoot,
    integration,
    accountFingerprint: createLangSmithUploadWriter(writer).accountFingerprint,
    writer,
    currentSessionId: "current-session",
    wakeCurrent: async () => {
      currentWakes.push("current-session");
      return "launched";
    },
    createSession: () => {
      throw new Error("Current session should not request adapter recovery options");
    },
  };
  const report = await recoverTracingSessions(runtime, {
    optionsForSession: () => {
      throw new Error("Current session should be excluded before adapter lookup");
    },
    minimumForeignAgeMs: 0,
    now: Date.now() + 1,
    excludeCurrentSession: true,
  });
  expect(report).toEqual({ scheduled: [], failed: [] });
  expect(currentWakes).toEqual([]);
  expect(
    await createCaptureStore(storageRoot).enumerate(integration, "current-session"),
  ).toHaveLength(1);
});

it("reports a scope change after drain without scanning the previous account", async () => {
  const storageRoot = createRoot();
  const { writer } = await createLocalWriter();
  let scopeChecks = 0;
  const reports: unknown[] = [];
  const session = createTracingEngine({ storageRoot, integration, writer }).forSession({
    sessionId: "scope-change-session",
    resolveScope: (expected) => {
      scopeChecks += 1;
      return scopeChecks <= 2 ? expected : { ...expected, accountFingerprint: "new-account" };
    },
    scheduleWake: () => {
      throw new Error("Unexpected worker launch");
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
    backgroundRecovery: {
      onReport: (report) => {
        reports.push(report);
      },
      optionsForSession: () => {
        throw new Error("Scope mismatch should skip adapter recovery options");
      },
    },
  });

  await expect(session.drain()).resolves.toBe("idle");
  expect(reports).toEqual([{ status: "scope-mismatch" }]);
  expect(
    existsSync(
      backgroundRecoveryPaths(storageRoot, {
        integration,
        accountFingerprint: createLangSmithUploadWriter(writer).accountFingerprint,
      }).marker,
    ),
  ).toBe(false);
});

it("keeps ordinary drain behavior when background recovery is not configured", async () => {
  const storageRoot = createRoot();
  const { writer, requests } = await createLocalWriter();
  await capturePendingSession(storageRoot, "ordinary-session", writer);
  const engine = createTracingEngine({ storageRoot, integration, writer });
  const session = engine.forSession({
    sessionId: "ordinary-session",
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      throw new Error("Unexpected worker launch");
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
  });

  await expect(session.drain()).resolves.toBe("completed");
  expect(requests.some(({ method }) => method === "POST")).toBe(true);
  expect(
    existsSync(
      backgroundRecoveryPaths(storageRoot, {
        integration,
        accountFingerprint: createLangSmithUploadWriter(writer).accountFingerprint,
      }).marker,
    ),
  ).toBe(false);
});
