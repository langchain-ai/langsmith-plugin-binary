import { spawn, type ChildProcess } from "node:child_process";
import { waitFor } from "../../test-support/wait.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { childEnvironment, moduleUrl, temporaryRoot } from "../../test-support/tracing/delivery.js";
import {
  BACKGROUND_WORKER_ACTIVE_MARKER_NAME,
  BACKGROUND_WORKER_ATTEMPT_NAME,
} from "./constants.js";
import type { BackgroundWorkerOptions, BackgroundWorkerScope } from "./models.js";
import { workerDirectory, workerLaunchPath, workerLockPath, workerPendingPath } from "./paths.js";
import { createBackgroundWorker } from "./worker.js";

const scope: BackgroundWorkerScope = {
  integration: "claude",
  sessionId: "worker-session",
  accountFingerprint: "worker-account",
};
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

const text = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

function spawnChild(program: string, module: string, input: object): number {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL(`./fixtures/${program}`, import.meta.url)),
      moduleUrl(module),
      JSON.stringify(input),
    ],
    {
      env: childEnvironment(temporaryRoot()),
      stdio: "ignore",
    },
  );
  children.push(child);
  return child.pid!;
}

function gatedLauncher(root: string) {
  const files = { gate: join(root, "claim gate"), ready: join(root, "child ready") };
  const input = { lockPath: workerLockPath(root, scope), ...files };
  return {
    ...files,
    launch: () => spawnChild("claiming-worker.mjs", "dist/storage/index.js", input),
  };
}

function runningLauncher(root: string, mode: "hold" | "progress" | "retry") {
  const passes = join(root, "passes");
  const input = { mode, root, scope, passes };
  const launch = () =>
    spawnChild("running-worker.mjs", "dist/tracing/background-worker/index.js", input);
  return { passes, launch, count: () => Number(readFileSync(passes, "utf8")) };
}

function worker(root: string, options: Partial<BackgroundWorkerOptions> = {}) {
  return createBackgroundWorker({
    storageRoot: root,
    scope,
    resolveScope: () => scope,
    launchWorker: () => {
      throw new Error("unexpected launch");
    },
    drainPending: () => "idle",
    ...options,
  });
}

function stateNames(root: string, pattern: RegExp): string[] {
  const directory = workerDirectory(root, scope);
  return existsSync(directory) ? readdirSync(directory).filter((name) => pattern.test(name)) : [];
}

it("waits for the launched child to claim the lock before reporting a handoff", async () => {
  const root = temporaryRoot();
  const child = gatedLauncher(root);
  let settled = false;
  const wake = worker(root, { launchWorker: child.launch, startupWaitMs: 8_000 }).wake();
  void wake.then(
    () => (settled = true),
    () => (settled = true),
  );
  await waitFor(() => existsSync(child.ready));
  await delay(40);
  expect(settled).toBe(false);
  expect(existsSync(workerPendingPath(root, scope))).toBe(true);
  writeFileSync(child.gate, "");
  await expect(wake).resolves.toBe("launched");
}, 20_000);

it("reports an unclaimed launch and queues later wakes under its lease", async () => {
  const root = temporaryRoot();
  const child = gatedLauncher(root);
  let launches = 0;
  const lateWorker = worker(root, {
    launchWorker: () => {
      launches += 1;
      return child.launch();
    },
    startupWaitMs: 70,
  });
  const first = lateWorker.wake().catch((error: unknown) => error);
  await waitFor(() => existsSync(child.ready));
  await expect(Promise.all([lateWorker.wake(), lateWorker.wake()])).resolves.toEqual([
    "queued",
    "queued",
  ]);
  expect(String(await first)).toContain("did not claim its lock");
  await expect(lateWorker.wake()).resolves.toBe("queued");
  expect(launches).toBe(1);
  expect(existsSync(workerLaunchPath(root, scope))).toBe(true);
});

it("keeps the wake pending when the launcher fails or returns its own process", async () => {
  const root = temporaryRoot();
  await expect(worker(root).wake()).rejects.toThrow("unexpected launch");
  await expect(worker(root, { launchWorker: () => process.pid }).wake()).rejects.toThrow(
    "child process ID",
  );
  expect(existsSync(workerPendingPath(root, scope))).toBe(true);
  expect(() => worker(root, { startupWaitMs: 0 })).toThrow("startup wait");
});

it("runs progressed passes until idle and clears its own launch lease", async () => {
  const root = temporaryRoot();
  const child = runningLauncher(root, "progress");
  await expect(
    worker(root, { launchWorker: child.launch, startupWaitMs: 8_000 }).wake(),
  ).resolves.toBe("launched");
  await waitFor(() => text(`${child.passes}.result`) !== "");
  expect(child.count()).toBe(3);
  expect(readFileSync(`${child.passes}.result`, "utf8")).toBe("completed");
  expect(existsSync(workerLaunchPath(root, scope))).toBe(false);
  expect(existsSync(workerPendingPath(root, scope))).toBe(false);
}, 20_000);

it("resumes an active marker and its retry budget after the owner is killed", async () => {
  for (const mode of ["hold", "retry"] as const) {
    const root = temporaryRoot();
    const child = runningLauncher(root, mode);
    await worker(root, { launchWorker: child.launch, startupWaitMs: 8_000 }).wake();
    const attempts = () => stateNames(root, BACKGROUND_WORKER_ATTEMPT_NAME).length;
    await waitFor(() => (mode === "hold" ? text(child.passes) === "1" : attempts() > 0));
    for (const owner of children.splice(0)) owner.kill("SIGKILL");
    const drainPending = () => {
      writeFileSync(child.passes, String(child.count() + 1));
      return mode === "hold" ? "idle" : "retryable-failure";
    };
    const retryPolicy = { maxAttempts: 2, retryDelayMs: 0 };
    await expect(worker(root, { drainPending, retryPolicy }).run()).resolves.toBe(
      mode === "hold" ? "completed" : "retry-exhausted",
    );
    expect(child.count()).toBe(2);
  }
}, 20_000);

it("bounds failures across wakes and keeps the lock through retry delays", async () => {
  const root = temporaryRoot();
  const wakes: Promise<string>[] = [];
  let passes = 0;
  const competitor = worker(root, { launchWorker: () => 1 });
  const failing = worker(root, {
    drainPending: () => {
      passes += 1;
      if (passes === 1) setTimeout(() => wakes.push(competitor.wake()), 100);
      return "retryable-failure";
    },
    retryPolicy: { maxAttempts: 2, retryDelayMs: 300 },
  });
  await failing.wake().catch(() => {});
  writeFileSync(join(workerDirectory(root, scope), `.${randomUUID()}.tmp`), "");
  await expect(failing.run()).resolves.toBe("retry-exhausted");
  await expect(Promise.all(wakes)).resolves.toEqual(["queued"]);
  expect(passes).toBe(2);
  expect(existsSync(workerPendingPath(root, scope))).toBe(true);
  expect(stateNames(root, BACKGROUND_WORKER_ATTEMPT_NAME)).toEqual([]);
});

it("rechecks the account around every task and keeps sessions apart", async () => {
  const root = temporaryRoot();
  const mutableScope = { ...scope };
  let current = scope;
  let switchDuring: "reconstruct" | "drain" | undefined;
  let drainResult: "idle" | "retryable-failure" = "idle";
  const drains: string[] = [];
  const switchAccount = (task: string) => {
    if (switchDuring === task) current = { ...scope, accountFingerprint: "other-account" };
  };
  const switching = worker(root, {
    scope: mutableScope,
    resolveScope: () => current,
    reconstructPending: () => {
      switchAccount("reconstruct");
      return "idle";
    },
    drainPending: () => {
      drains.push(switchDuring ?? "none");
      switchAccount("drain");
      return drainResult;
    },
    retryPolicy: { maxAttempts: 1, retryDelayMs: 0 },
  });
  mutableScope.sessionId = "mutated-session";
  await switching.wake().catch(() => {});
  const otherSession = worker(root, { scope: mutableScope, resolveScope: () => mutableScope });
  await expect(otherSession.run()).resolves.toBe("idle");
  expect(existsSync(workerPendingPath(root, scope))).toBe(true);
  for (const [task, result] of [
    ["reconstruct", "idle"],
    ["drain", "retryable-failure"],
    ["drain", "idle"],
  ] as const) {
    [switchDuring, drainResult, current] = [task, result, scope];
    await expect(switching.run()).resolves.toBe("scope-mismatch");
    expect(stateNames(root, BACKGROUND_WORKER_ACTIVE_MARKER_NAME)).toHaveLength(1);
    expect(stateNames(root, BACKGROUND_WORKER_ATTEMPT_NAME)).toEqual([]);
  }
  [switchDuring, drainResult, current] = [undefined, "idle", scope];
  await expect(switching.run()).resolves.toBe("completed");
  expect(drains).toEqual(["drain", "drain", "none"]);
  expect(stateNames(root, BACKGROUND_WORKER_ACTIVE_MARKER_NAME)).toEqual([]);
});
