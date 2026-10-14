import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { temporaryRoot } from "../../test-support/tracing/delivery.js";
import {
  runPost,
  save,
  testBridge,
  turnEvidence,
  writerFor,
} from "../../test-support/tracing/lifecycle.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import { runBackgroundRecovery } from "./background-recovery.js";
import type {
  TracingEngineRecoveryOptions,
  TracingEngineRecoveryRuntime,
  TracingEngineSession,
} from "./models.js";

const URL = "http://127.0.0.1:1/api/v1";

async function setup(apiKey?: string) {
  const root = temporaryRoot();
  const writer = writerFor(URL, apiKey);
  await save(
    testBridge(root, URL, { sessionId: "foreign", writer }),
    "turn",
    "root",
    runPost("root"),
    turnEvidence("open", []),
  );
  const runtime: TracingEngineRecoveryRuntime = {
    storageRoot: root,
    integration: "claude-code",
    accountFingerprint: createLangSmithUploadWriter(writer).accountFingerprint,
    writer,
    currentSessionId: "current",
    wakeCurrent: vi.fn(),
    createSession: () => ({ wake: async () => "queued" }) as unknown as TracingEngineSession,
  };
  const scans: string[] = [];
  const recovery = {
    minimumForeignAgeMs: 0,
    onReport: vi.fn(),
    optionsForSession: vi.fn<TracingEngineRecoveryOptions["optionsForSession"]>(
      async (sessionId: string) => {
        scans.push(sessionId);
        throw new Error("adapter context unavailable");
      },
    ),
  };
  return { root, runtime, recovery, scans };
}

it("scans every time and leaves no checkpoint file behind", async () => {
  const account = await setup();
  await save(
    testBridge(account.root, URL, { sessionId: "current", writer: writerFor(URL) }),
    "turn",
    "root",
    runPost("root"),
    turnEvidence("open", []),
  );
  for (let scan = 0; scan < 2; scan += 1)
    await expect(runBackgroundRecovery(account.runtime, account.recovery)).resolves.toMatchObject({
      status: "partial",
      retryable: true,
      report: { failed: [{ sessionId: "foreign", message: "adapter context unavailable" }] },
    });
  expect(account.scans).toEqual(["foreign", "foreign"]);
  expect(account.runtime.wakeCurrent).not.toHaveBeenCalled();
  expect(existsSync(join(account.root, "background-recovery"))).toBe(false);
  const other = await setup("synthetic-other-key");
  const shared = { ...other.runtime, storageRoot: account.root };
  await expect(runBackgroundRecovery(shared, other.recovery)).resolves.toMatchObject({
    status: "completed",
  });
});

it("stops on a scope change or a failed scope check at every guard", async () => {
  for (const [failAt, expected] of [
    [1, { status: "scope-mismatch" }],
    [2, { status: "scope-mismatch" }],
    [3, { status: "scope-mismatch" }],
    [1, { status: "failed", message: "scope lookup failed", retryable: true }],
  ] as const) {
    const account = await setup();
    account.recovery.optionsForSession.mockImplementation(async () => ({
      reconstruct: vi.fn(),
      scheduleWake: vi.fn(),
      resolveScope: vi.fn(),
    }));
    const wakes = vi.fn(async () => "queued");
    account.runtime.createSession = () => ({ wake: wakes }) as unknown as TracingEngineSession;
    let checks = 0;
    const guard = async () => {
      checks += 1;
      if (checks === failAt && "message" in expected) throw new Error(expected.message);
      return checks !== failAt;
    };
    await expect(
      runBackgroundRecovery(account.runtime, account.recovery, guard),
    ).resolves.toMatchObject(expected);
    expect(wakes).toHaveBeenCalledTimes(failAt === 3 ? 1 : 0);
  }
});

it("reports a failed scan as retryable", async () => {
  const account = await setup();
  await expect(
    runBackgroundRecovery({ ...account.runtime, accountFingerprint: "other" }, account.recovery),
  ).resolves.toMatchObject({
    status: "failed",
    retryable: true,
    message: expect.stringContaining("account fingerprint"),
  });
});
