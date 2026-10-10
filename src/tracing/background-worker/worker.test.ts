import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { afterEach, expect, it } from "vitest";
import {
  BACKGROUND_WORKER_ACTIVE_MARKER_NAME,
  BACKGROUND_WORKER_ATTEMPT_NAME,
  BACKGROUND_WORKER_MARKER_VERSION,
} from "./constants.js";
import type {
  BackgroundWorker,
  BackgroundWorkerOptions,
  BackgroundWorkerPassResult,
  BackgroundWorkerScope,
} from "./models.js";
import { workerDirectory, workerLaunchPath, workerPendingPath } from "./paths.js";
import { createBackgroundWorker } from "./worker.js";

const childProgram = `
const fs = await import("node:fs");
const { setTimeout: delay } = await import("node:timers/promises");
const api = await import(process.argv[1]);
const { mode, storageRoot, integration, sessionId, accountFingerprint, statePath, gatePath, maxAttempts, retryDelayMs } = JSON.parse(process.argv[2]);
const scope = { integration, sessionId, accountFingerprint };
function increment() {
  const count = Number(fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : 0) + 1;
  fs.writeFileSync(statePath, String(count));
  return count;
}
const worker = api.createBackgroundWorker({
  storageRoot,
  scope,
  resolveScope: () => scope,
  launchWorker: () => { throw new Error("unexpected nested worker launch"); },
  retryPolicy: { maxAttempts: Number(maxAttempts), retryDelayMs: Number(retryDelayMs) },
  drainPending: async () => {
    const count = increment();
    if (mode === "hold") {
      fs.writeFileSync(statePath + ".entered", "ready");
      while (!fs.existsSync(gatePath)) await delay(5);
    }
    if (mode === "retry") return "retryable-failure";
    if (mode === "progress") return count < 3 ? "progressed" : "idle";
    return "idle";
  },
});
if (mode === "claim-gated" || mode === "start-gated") {
  fs.writeFileSync(statePath + ".ready", "ready");
  while (!fs.existsSync(gatePath)) await delay(5);
}
const result = await worker.run();
fs.writeFileSync(statePath + ".result", result);
`;

interface TestArea {
  root: string;
  children: Set<ChildProcess>;
}

const testAreas: TestArea[] = [];

function createArea(): TestArea {
  const area = {
    root: mkdtempSync(join(tmpdir(), "plugins base worker-")),
    children: new Set<ChildProcess>(),
  };
  testAreas.push(area);
  return area;
}

function makeScope(accountFingerprint = "worker-test-account"): BackgroundWorkerScope {
  return { integration: "claude", sessionId: "worker-test-session", accountFingerprint };
}

function spawnRunner(
  area: TestArea,
  scope: BackgroundWorkerScope,
  mode: string,
  statePath: string,
  gatePath: string,
  maxAttempts = 3,
  retryDelayMs = 0,
): ChildProcess {
  const moduleUrl = pathToFileURL(resolve("dist/tracing/background-worker/index.js")).href;
  const child = spawn(
    process.execPath,
    [
      "-e",
      childProgram,
      moduleUrl,
      JSON.stringify({
        mode,
        storageRoot: area.root,
        ...scope,
        statePath,
        gatePath,
        maxAttempts,
        retryDelayMs,
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
  return child;
}

function launchRunner(
  area: TestArea,
  scope: BackgroundWorkerScope,
  mode: string,
  statePath: string,
  gatePath: string,
  maxAttempts = 3,
  retryDelayMs = 0,
): number {
  return spawnRunner(area, scope, mode, statePath, gatePath, maxAttempts, retryDelayMs)
    .pid as number;
}

function lastChild(area: TestArea): ChildProcess {
  return [...area.children].at(-1)!;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Timed out waiting for background worker process state");
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  return child.exitCode;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child);
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

function makeWorker(
  area: TestArea,
  scope: BackgroundWorkerScope,
  launchWorker: BackgroundWorkerOptions["launchWorker"],
  drainPending: BackgroundWorkerOptions["drainPending"],
  options: Pick<BackgroundWorkerOptions, "retryPolicy" | "startupWaitMs"> = {},
) {
  return createBackgroundWorker({
    storageRoot: area.root,
    scope,
    resolveScope: () => scope,
    launchWorker,
    drainPending,
    ...options,
  });
}

function passCount(path: string): number {
  return Number(readFileSync(path, "utf8"));
}

async function seedPending(
  worker: Pick<BackgroundWorker, "run">,
  storageRoot: string,
  scope: BackgroundWorkerScope,
): Promise<void> {
  await worker.run();
  writeFileSync(
    workerPendingPath(storageRoot, scope),
    JSON.stringify({
      version: BACKGROUND_WORKER_MARKER_VERSION,
      id: randomUUID(),
      sourcePid: process.pid,
    }),
    { flag: "wx", mode: 0o600 },
  );
}

afterEach(async () => {
  for (const area of testAreas) {
    for (const child of area.children) await stopChild(child);
    cleanupArea(area.root);
  }
  testAreas.length = 0;
});

it("waits for the child lock claim before handing off from a path with spaces", async () => {
  const area = createArea();
  const scope = makeScope();
  const statePath = join(area.root, "passes");
  const gatePath = join(area.root, "claim gate");
  const worker = makeWorker(
    area,
    scope,
    () => launchRunner(area, scope, "claim-gated", statePath, gatePath),
    () => "idle",
    { startupWaitMs: 2_000 },
  );
  let settled = false;
  const wake = worker.wake();
  const wakeResult = wake.then(
    () => {
      settled = true;
      return true;
    },
    () => {
      settled = true;
      return false;
    },
  );
  await waitFor(() => existsSync(`${statePath}.ready`));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  expect(settled).toBe(false);
  writeFileSync(gatePath, "go");
  await expect(wake).resolves.toBe("launched");
  await expect(wakeResult).resolves.toBe(true);
  expect(await waitForExit(lastChild(area))).toBe(0);
  expect(passCount(statePath)).toBe(1);
  expect(readFileSync(`${statePath}.result`, "utf8")).toBe("completed");
});

it("coalesces burst wakes and lets a timed-out child start under its lease", async () => {
  const area = createArea();
  const scope = makeScope();
  const statePath = join(area.root, "passes");
  const gatePath = join(area.root, "late startup gate");
  let launches = 0;
  const worker = makeWorker(
    area,
    scope,
    () => {
      launches += 1;
      return launchRunner(area, scope, "start-gated", statePath, gatePath);
    },
    () => "idle",
    { startupWaitMs: 70 },
  );
  const firstWake = worker.wake();
  const firstWakeResult = firstWake.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await waitFor(() => existsSync(`${statePath}.ready`));
  await expect(Promise.all([worker.wake(), worker.wake(), worker.wake()])).resolves.toEqual([
    "queued",
    "queued",
    "queued",
  ]);
  const firstResult = await firstWakeResult;
  expect("error" in firstResult).toBe(true);
  if ("error" in firstResult) {
    expect(firstResult.error).toBeInstanceOf(Error);
    expect(String(firstResult.error)).toContain("did not claim its lock");
  }
  await expect(worker.wake()).resolves.toBe("queued");
  expect(launches).toBe(1);
  expect(existsSync(workerLaunchPath(area.root, scope))).toBe(true);
  writeFileSync(gatePath, "go");
  expect(await waitForExit(lastChild(area))).toBe(0);
  expect(passCount(statePath)).toBe(1);
  expect(existsSync(workerLaunchPath(area.root, scope))).toBe(false);
});

it("keeps running progressed passes until the worker is idle", async () => {
  const area = createArea();
  const scope = makeScope();
  const statePath = join(area.root, "passes");
  const worker = makeWorker(
    area,
    scope,
    () => launchRunner(area, scope, "progress", statePath, "", 1, 0),
    () => "idle",
  );
  await expect(worker.wake()).resolves.toBe("launched");
  expect(await waitForExit(lastChild(area))).toBe(0);
  expect(passCount(statePath)).toBe(3);
  expect(readFileSync(`${statePath}.result`, "utf8")).toBe("completed");
});

it("continues a persisted retry budget after its owner exits", async () => {
  const area = createArea();
  const scope = makeScope();
  const statePath = join(area.root, "passes");
  const directory = workerDirectory(area.root, scope);
  const worker = makeWorker(
    area,
    scope,
    () => launchRunner(area, scope, "retry", statePath, "", 2, 20_000),
    () => {
      writeFileSync(statePath, String(passCount(statePath) + 1));
      return "retryable-failure";
    },
    { retryPolicy: { maxAttempts: 2, retryDelayMs: 0 } },
  );
  await expect(worker.wake()).resolves.toBe("launched");
  await waitFor(() =>
    readdirSync(directory).some((name) => BACKGROUND_WORKER_ATTEMPT_NAME.test(name)),
  );
  await stopChild(lastChild(area));
  await expect(worker.run()).resolves.toBe("retry-exhausted");
  expect(passCount(statePath)).toBe(2);
});

it("bounds failures across wake generations and preserves the next wake", async () => {
  const area = createArea();
  const scope = makeScope();
  const statePath = join(area.root, "passes");
  let wakeups = 0;
  const worker = makeWorker(
    area,
    scope,
    () => {
      throw new Error("unexpected nested worker launch");
    },
    async () => {
      const passes = existsSync(statePath) ? passCount(statePath) + 1 : 1;
      writeFileSync(statePath, String(passes));
      if (passes <= 4) {
        wakeups += 1;
        await expect(worker.wake()).resolves.toBe("queued");
      }
      return "retryable-failure" as const;
    },
    { retryPolicy: { maxAttempts: 2, retryDelayMs: 0 } },
  );
  await seedPending(worker, area.root, scope);

  await expect(worker.run()).resolves.toBe("retry-exhausted");

  expect(passCount(statePath)).toBe(2);
  expect(wakeups).toBe(2);
  expect(existsSync(workerPendingPath(area.root, scope))).toBe(true);
});

it("keeps the worker lock during retry delay so wakes do not launch another child", async () => {
  const area = createArea();
  const scope = makeScope();
  const statePath = join(area.root, "passes");
  const firstWorker = makeWorker(
    area,
    scope,
    () => {
      throw new Error("unexpected nested worker launch");
    },
    () => {
      writeFileSync(statePath, String((existsSync(statePath) ? passCount(statePath) : 0) + 1));
      return "retryable-failure";
    },
    { retryPolicy: { maxAttempts: 2, retryDelayMs: 300 } },
  );
  let childLaunches = 0;
  const secondWorker = makeWorker(
    area,
    scope,
    () => {
      childLaunches += 1;
      return launchRunner(area, scope, "idle", statePath, "");
    },
    () => "idle",
  );
  await seedPending(firstWorker, area.root, scope);
  const run = firstWorker.run();
  await waitFor(() => existsSync(statePath));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));

  const wakeResult = await secondWorker.wake();
  const runResult = await run;

  expect(wakeResult).toBe("queued");
  expect(childLaunches).toBe(0);
  expect(runResult).toBe("retry-exhausted");
  expect(passCount(statePath)).toBe(2);
  expect(existsSync(workerPendingPath(area.root, scope))).toBe(true);
});

it("recovers an active marker after its worker process is killed", async () => {
  const area = createArea();
  const scope = makeScope();
  const statePath = join(area.root, "passes");
  const gatePath = join(area.root, "owner gate");
  const worker = makeWorker(
    area,
    scope,
    () => launchRunner(area, scope, "hold", statePath, gatePath),
    () => {
      writeFileSync(statePath, String(passCount(statePath) + 1));
      return "idle";
    },
  );
  await expect(worker.wake()).resolves.toBe("launched");
  await waitFor(() => existsSync(`${statePath}.entered`));
  await stopChild(lastChild(area));
  await expect(worker.run()).resolves.toBe("completed");
  expect(passCount(statePath)).toBe(2);
});

it("retains failed launches and isolates a snapshotted scope and retry policy", async () => {
  const area = createArea();
  const scope = makeScope("worker-test-account-a");
  const expectedScope = { ...scope };
  const retryPolicy = { maxAttempts: 2, retryDelayMs: 0 };
  let attempts = 0;
  let otherScopeAttempts = 0;
  let replacementLaunches = 0;
  const options: BackgroundWorkerOptions = {
    storageRoot: area.root,
    scope,
    resolveScope: () => expectedScope,
    launchWorker: () => {
      throw new Error("worker launch failed");
    },
    drainPending: () => {
      attempts += 1;
      return "retryable-failure";
    },
    retryPolicy,
  };
  const worker = createBackgroundWorker(options);
  const otherScope = makeScope("worker-test-account-b");
  const other = createBackgroundWorker({
    storageRoot: area.root,
    scope: otherScope,
    resolveScope: () => otherScope,
    launchWorker: () => 0,
    drainPending: () => {
      otherScopeAttempts += 1;
      return "idle";
    },
  });
  await expect(worker.wake()).rejects.toThrow("worker launch failed");
  scope.accountFingerprint = otherScope.accountFingerprint;
  scope.integration = otherScope.integration;
  retryPolicy.maxAttempts = 1;
  options.launchWorker = () => {
    replacementLaunches += 1;
    return process.pid + 1;
  };
  await expect(worker.wake()).rejects.toThrow("worker launch failed");
  await expect(other.run()).resolves.toBe("idle");
  await expect(worker.run()).resolves.toBe("retry-exhausted");
  expect(attempts).toBe(2);
  expect(otherScopeAttempts).toBe(0);
  expect(replacementLaunches).toBe(0);
});

it("rechecks account scope between reconstruction and delivery and before acknowledging work", async () => {
  const area = createArea();
  const scope = makeScope("worker-test-account-a");
  let currentScope = scope;
  let reconstructionCalls = 0;
  let drainCalls = 0;
  let enterReconstruction: (() => void) | undefined;
  let releaseReconstruction: (() => void) | undefined;
  let enterRetryDrain: (() => void) | undefined;
  let releaseRetryDrain: (() => void) | undefined;
  let enterIdleDrain: (() => void) | undefined;
  let releaseIdleDrain: (() => void) | undefined;
  const reconstructionEntered = new Promise<void>((resolvePromise) => {
    enterReconstruction = resolvePromise;
  });
  const reconstructionGate = new Promise<void>((resolvePromise) => {
    releaseReconstruction = resolvePromise;
  });
  const retryDrainEntered = new Promise<void>((resolvePromise) => {
    enterRetryDrain = resolvePromise;
  });
  const retryDrainGate = new Promise<void>((resolvePromise) => {
    releaseRetryDrain = resolvePromise;
  });
  const idleDrainEntered = new Promise<void>((resolvePromise) => {
    enterIdleDrain = resolvePromise;
  });
  const idleDrainGate = new Promise<void>((resolvePromise) => {
    releaseIdleDrain = resolvePromise;
  });
  const worker = createBackgroundWorker({
    storageRoot: area.root,
    scope,
    resolveScope: () => currentScope,
    launchWorker: () => {
      throw new Error("seed pending wake");
    },
    reconstructPending: async (): Promise<BackgroundWorkerPassResult> => {
      reconstructionCalls += 1;
      if (reconstructionCalls === 1) {
        enterReconstruction?.();
        await reconstructionGate;
      }
      return "idle";
    },
    drainPending: async () => {
      drainCalls += 1;
      if (reconstructionCalls > 1 && drainCalls === 1) {
        enterRetryDrain?.();
        await retryDrainGate;
        return "retryable-failure";
      }
      if (reconstructionCalls > 2 && drainCalls === 2) {
        enterIdleDrain?.();
        await idleDrainGate;
      }
      return "idle";
    },
    retryPolicy: { maxAttempts: 1, retryDelayMs: 0 },
  });
  const activeMarkerExists = () =>
    readdirSync(workerDirectory(area.root, scope)).some((name) =>
      BACKGROUND_WORKER_ACTIVE_MARKER_NAME.test(name),
    );
  const attemptCount = () =>
    readdirSync(workerDirectory(area.root, scope)).filter((name) =>
      BACKGROUND_WORKER_ATTEMPT_NAME.test(name),
    ).length;
  await expect(worker.wake()).rejects.toThrow("seed pending wake");

  const reconstructionRun = worker.run();
  await reconstructionEntered;
  currentScope = makeScope("worker-test-account-b");
  releaseReconstruction?.();
  await expect(reconstructionRun).resolves.toBe("scope-mismatch");
  expect(drainCalls).toBe(0);
  expect(activeMarkerExists()).toBe(true);
  expect(attemptCount()).toBe(0);

  currentScope = scope;
  const retryRun = worker.run();
  await retryDrainEntered;
  currentScope = makeScope("worker-test-account-b");
  releaseRetryDrain?.();
  await expect(retryRun).resolves.toBe("scope-mismatch");
  expect(activeMarkerExists()).toBe(true);
  expect(attemptCount()).toBe(0);

  currentScope = scope;
  const idleRun = worker.run();
  await idleDrainEntered;
  currentScope = makeScope("worker-test-account-b");
  releaseIdleDrain?.();
  await expect(idleRun).resolves.toBe("scope-mismatch");
  expect(activeMarkerExists()).toBe(true);

  currentScope = scope;
  await expect(worker.run()).resolves.toBe("completed");
  expect(activeMarkerExists()).toBe(false);
});

it("isolates wakes and scope checks for sessions under one account", async () => {
  const area = createArea();
  const scopeA = { ...makeScope("worker-test-account-a"), sessionId: "session-a" };
  const scopeB = { ...scopeA, sessionId: "session-b" };
  let currentScopeA = scopeA;
  let callsA = 0;
  let callsB = 0;
  const workerA = createBackgroundWorker({
    storageRoot: area.root,
    scope: scopeA,
    resolveScope: () => currentScopeA,
    launchWorker: () => {
      throw new Error("seed pending wake");
    },
    drainPending: () => {
      callsA += 1;
      return "idle";
    },
  });
  const workerB = createBackgroundWorker({
    storageRoot: area.root,
    scope: scopeB,
    resolveScope: () => scopeB,
    launchWorker: () => {
      throw new Error("unexpected worker launch");
    },
    drainPending: () => {
      callsB += 1;
      return "idle";
    },
  });

  await seedPending(workerA, area.root, scopeA);
  await expect(workerB.run()).resolves.toBe("idle");
  expect(callsB).toBe(0);
  expect(existsSync(workerPendingPath(area.root, scopeA))).toBe(true);

  currentScopeA = scopeB;
  await expect(workerA.run()).resolves.toBe("scope-mismatch");
  expect(callsA).toBe(0);
  expect(existsSync(workerPendingPath(area.root, scopeA))).toBe(true);

  currentScopeA = scopeA;
  await expect(workerA.run()).resolves.toBe("completed");
  expect(callsA).toBe(1);
  expect(existsSync(workerPendingPath(area.root, scopeA))).toBe(false);
});
