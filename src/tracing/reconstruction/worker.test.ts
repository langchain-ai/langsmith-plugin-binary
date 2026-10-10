import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { StoredCapture } from "../../storage/capture/models.js";
import { DELIVERY_RETRY_EXHAUSTED_REASON } from "../delivery/constants.js";
import type { LifecycleCaptureInput, LifecycleCaptureResult } from "../lifecycle/models.js";
import { createLifecycleBridge } from "../lifecycle/index.js";
import type { DeliveryPolicy } from "../delivery/models.js";
import type {
  LangSmithUploadDestinationConfig,
  PreparedRunPostSubmission,
} from "../upload/models.js";
import { RECONSTRUCTION_DIRECTORY, RECONSTRUCTION_JOB_KIND } from "./constants.js";
import { createReconstructionWorker } from "./index.js";
import type {
  ReconstructionJob,
  ReconstructionResult,
  ReconstructionWorkerOptions,
} from "./models.js";

function job(eventId: string, privacyMode: "full" | "metadata" = "full") {
  return {
    turnId: "turn-1",
    eventId,
    sourceRefs: [`snapshot:${eventId}`],
    privacyMode,
    turnEvidence: { childRunIds: ["child-1"], closureState: "authoritative" as const },
  };
}

function post(id: string, privacyMode: "full" | "metadata" = "full"): PreparedRunPostSubmission {
  return {
    operation: "post",
    integration: "claude-code",
    privacyMode,
    metadata: {
      integration: "claude-code",
      threadId: "thread-1",
      agentType: "root",
      runType: "root",
    },
    run: { id, name: "test run", run_type: "chain", inputs: { prompt: "safe" } },
  };
}

function published() {
  return { status: "published", record: {} as StoredCapture } as const;
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugins-base-reconstruction-"));
}

async function contents(path: string): Promise<string[]> {
  const values: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) values.push(...(await contents(child)));
    else values.push(await readFile(child, "utf8"));
  }
  return values;
}

function worker(
  storageRoot: string,
  accountFingerprint: string,
  reconstruct: (value: ReconstructionJob) => Promise<ReconstructionResult>,
  capture: (input: LifecycleCaptureInput) => Promise<LifecycleCaptureResult>,
  policy: Partial<DeliveryPolicy> = {},
) {
  return createReconstructionWorker({
    storageRoot,
    integration: "claude-code",
    sessionId: "session-1",
    bridge: { accountFingerprint, capture },
    reconstruct,
    policy,
  });
}

function bridge(storageRoot: string) {
  const destination: LangSmithUploadDestinationConfig = {
    apiKey: "synthetic-reconstruction-test-key",
    apiUrl: "https://example.test/api/v1",
    projectName: "reconstruction-test",
  };
  return createLifecycleBridge({
    storageRoot,
    integration: "claude-code",
    sessionId: "session-1",
    writer: { destinations: [destination], redact: false },
  });
}

function jobStore(storageRoot: string) {
  return createCaptureStore(join(storageRoot, RECONSTRUCTION_DIRECTORY));
}

describe("durable reconstruction jobs", () => {
  it("replays partial captures without counting duplicate outputs as progress", async () => {
    const storageRoot = await root();
    const lifecycleBridge = bridge(storageRoot);
    const captureCalls: LifecycleCaptureInput[] = [];
    const reconstruct = vi.fn(async () => ({
      status: "ready" as const,
      outputs: [
        { eventId: "event-root", submission: post("run-root") },
        { eventId: "event-child", submission: post("run-child", "metadata") },
      ],
    }));
    const firstCapture = vi.fn(async (input: LifecycleCaptureInput) => {
      captureCalls.push(input);
      return input.eventId === "event-child"
        ? { status: "deferred" as const, reason: "missing-thread-identity" as const }
        : lifecycleBridge.capture(input);
    });
    const firstWorker = worker(
      storageRoot,
      lifecycleBridge.accountFingerprint,
      reconstruct,
      firstCapture,
    );
    expect((await firstWorker.enqueue(job("job-1"))).status).toBe("published");
    const first = await firstWorker.drain();
    expect(first).toMatchObject({
      status: "drained",
      captured: 1,
      deferred: 1,
      failed: 0,
      pending: 1,
    });
    expect(
      (await createCaptureStore(storageRoot).enumerate("claude-code", "session-1")).map(
        ({ record }) => record.eventId,
      ),
    ).toEqual(["event-root"]);

    const repeated = await firstWorker.drain();
    expect(repeated).toMatchObject({
      status: "drained",
      captured: 0,
      deferred: 1,
      failed: 0,
      pending: 1,
    });

    const restartedCapture = vi.fn(async (input: LifecycleCaptureInput) => {
      captureCalls.push(input);
      return lifecycleBridge.capture(input);
    });
    const restarted = worker(
      storageRoot,
      lifecycleBridge.accountFingerprint,
      reconstruct,
      restartedCapture,
    );
    const second = await restarted.drain();
    expect(second).toMatchObject({ status: "drained", captured: 1, failed: 0, pending: 0 });
    expect(captureCalls.map(({ eventId }) => eventId)).toEqual([
      "event-root",
      "event-child",
      "event-root",
      "event-child",
      "event-root",
      "event-child",
    ]);
    expect(restartedCapture.mock.calls.map(([input]) => input.submission.privacyMode)).toEqual([
      "full",
      "metadata",
    ]);
    expect(
      (await createCaptureStore(storageRoot).enumerate("claude-code", "session-1")).map(
        ({ record }) => record.eventId,
      ),
    ).toEqual(["event-root", "event-child"]);
    expect(await restarted.drain()).toMatchObject({ status: "drained", pending: 0 });
    expect(reconstruct).toHaveBeenCalledTimes(3);
  });

  it("keeps duplicate jobs immutable, defers missing identity without an attempt, and isolates accounts", async () => {
    const storageRoot = await root();
    const reconstruct = vi
      .fn()
      .mockResolvedValueOnce({
        status: "deferred" as const,
        reason: "missing-thread-identity" as const,
      })
      .mockResolvedValue({
        status: "ready" as const,
        outputs: [{ eventId: "event-1", submission: post("run-1", "metadata") }],
      });
    const capture = vi.fn(async () => published());
    const accountA = worker(storageRoot, "account-a", reconstruct, capture, { maxAttempts: 1 });
    expect((await accountA.enqueue(job("job-2", "metadata"))).status).toBe("published");
    expect((await accountA.enqueue(job("job-2", "metadata"))).status).toBe("duplicate");
    expect(
      (await accountA.enqueue({ ...job("job-2", "metadata"), sourceRefs: ["snapshot:changed"] }))
        .status,
    ).toBe("conflict");
    expect(await createCaptureStore(storageRoot).enumerate("claude-code", "session-1")).toEqual([]);

    const accountB = worker(
      storageRoot,
      "account-b",
      vi.fn(),
      vi.fn(async () => published()),
      { maxAttempts: 1 },
    );
    expect((await accountB.enqueue(job("job-2", "metadata"))).status).toBe("conflict");
    expect(await accountB.drain()).toMatchObject({
      status: "drained",
      pending: 1,
      accountMismatch: 1,
    });
    expect(reconstruct).toHaveBeenCalledTimes(0);

    expect(await accountA.drain()).toMatchObject({
      status: "drained",
      deferred: 1,
      failed: 0,
      pending: 1,
    });
    expect(await accountA.drain()).toMatchObject({ status: "drained", captured: 1, pending: 0 });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("rejects full-mode output from metadata jobs and bounds interpreter failures", async () => {
    const storageRoot = await root();
    const secret = "private-reconstruction-marker";
    const reconstruct = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary interpretation failure"))
      .mockResolvedValue({
        status: "ready" as const,
        outputs: [
          {
            eventId: "event-private",
            submission: {
              ...post("run-private"),
              run: { ...post("run-private").run, inputs: { prompt: secret } },
            },
          },
        ],
      });
    const capture = vi.fn(async () => published());
    const reconstructionWorker = worker(storageRoot, "account-a", reconstruct, capture, {
      maxAttempts: 2,
    });
    await reconstructionWorker.enqueue(job("job-3", "metadata"));
    expect(await reconstructionWorker.drain()).toMatchObject({
      status: "drained",
      failed: 1,
      pending: 1,
    });
    expect(await reconstructionWorker.drain()).toMatchObject({
      status: "drained",
      failed: 1,
      dropped: 1,
      pending: 0,
    });
    expect(await reconstructionWorker.drain()).toMatchObject({
      status: "drained",
      failed: 0,
      pending: 0,
    });
    expect(reconstruct).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled();
    expect((await contents(join(storageRoot, "reconstruction-v1"))).join("\n")).not.toContain(
      secret,
    );
  });

  it("bounds malformed callback envelopes and rejects unknown deferrals", async () => {
    const storageRoot = await root();
    const malformedResults: Record<string, unknown> = {
      "job-null": null,
      "job-status": { status: "unknown" },
      "job-deferred": { status: "deferred", reason: "unexpected" },
    };
    const reconstruct = vi.fn(
      async (value: ReconstructionJob) => malformedResults[value.eventId] as ReconstructionResult,
    );
    const capture = vi.fn(async () => published());
    const reconstructionWorker = worker(storageRoot, "account-a", reconstruct, capture, {
      maxAttempts: 1,
    });
    const eventIds = Object.keys(malformedResults);
    for (const eventId of eventIds) await reconstructionWorker.enqueue(job(eventId, "metadata"));

    expect(await reconstructionWorker.drain()).toMatchObject({
      status: "drained",
      failed: 3,
      dropped: 3,
      pending: 0,
    });
    expect(reconstruct).toHaveBeenCalledTimes(3);
    expect(capture).not.toHaveBeenCalled();
    for (const eventId of eventIds) {
      await expect(
        jobStore(storageRoot).readOutcome(
          {
            integration: "claude-code",
            sessionId: "session-1",
            turnId: "turn-1",
            eventId,
          },
          "account-a",
        ),
      ).resolves.toMatchObject({
        status: "settled",
        receipt: { outcome: "dropped", reason: DELIVERY_RETRY_EXHAUSTED_REASON },
      });
    }

    const malformedCaptureWorker = worker(
      storageRoot,
      "account-a",
      vi.fn(async () => ({
        status: "ready" as const,
        outputs: [
          { eventId: "output-null-capture", submission: post("run-null-capture", "metadata") },
        ],
      })),
      vi.fn(async () => null as never),
      { maxAttempts: 1 },
    );
    await malformedCaptureWorker.enqueue(job("job-null-capture", "metadata"));

    expect(await malformedCaptureWorker.drain()).toMatchObject({
      status: "drained",
      failed: 1,
      dropped: 1,
      pending: 0,
    });
    await expect(
      jobStore(storageRoot).readOutcome(
        {
          integration: "claude-code",
          sessionId: "session-1",
          turnId: "turn-1",
          eventId: "job-null-capture",
        },
        "account-a",
      ),
    ).resolves.toMatchObject({
      status: "settled",
      receipt: { outcome: "dropped", reason: DELIVERY_RETRY_EXHAUSTED_REASON },
    });
  });

  it("snapshots account and privacy policy before invoking a mutable callback", async () => {
    const storageRoot = await root();
    const originalCapture = vi.fn(async () => published());
    const replacementCapture = vi.fn(async () => published());
    const reconstruct = vi.fn(async (value: ReconstructionJob) => {
      try {
        (value as unknown as { privacyMode: string }).privacyMode = "full";
      } catch {}
      return {
        status: "ready" as const,
        outputs: [{ eventId: "event-mutated", submission: post("run-mutated") }],
      };
    });
    const options: ReconstructionWorkerOptions = {
      storageRoot,
      integration: "claude-code",
      sessionId: "session-1",
      bridge: { accountFingerprint: "account-a", capture: originalCapture },
      reconstruct,
      policy: { maxAttempts: 1 },
    };
    const reconstructionWorker = createReconstructionWorker(options);
    await reconstructionWorker.enqueue(job("job-mutated", "metadata"));
    options.bridge = { accountFingerprint: "account-b", capture: replacementCapture };
    options.reconstruct = vi.fn();

    expect(await reconstructionWorker.drain()).toMatchObject({
      status: "drained",
      failed: 1,
      dropped: 1,
      pending: 0,
    });
    expect(reconstruct).toHaveBeenCalledTimes(1);
    expect(originalCapture).not.toHaveBeenCalled();
    expect(replacementCapture).not.toHaveBeenCalled();
  });

  it("stores an optional root run ID and forwards it to reconstruction and capture", async () => {
    const storageRoot = await root();
    const reconstruct = vi.fn(async (_value: ReconstructionJob) => ({
      status: "ready" as const,
      outputs: [
        { eventId: "event-root-evidence", submission: post("run-root-evidence", "metadata") },
      ],
    }));
    const capture = vi.fn(async (_input: LifecycleCaptureInput) => published());
    const reconstructionWorker = worker(storageRoot, "account-a", reconstruct, capture);
    const turnEvidence = {
      rootRunId: "root-run-1",
      childRunIds: ["child-run-1"],
      closureState: "authoritative" as const,
    };
    await reconstructionWorker.enqueue({ ...job("job-root-evidence", "metadata"), turnEvidence });

    expect(await reconstructionWorker.drain()).toMatchObject({ status: "drained", captured: 1 });
    const storedJob = (await jobStore(storageRoot).enumerate("claude-code", "session-1")).find(
      ({ record }) => record.eventKind === RECONSTRUCTION_JOB_KIND,
    )?.record;
    expect(storedJob?.turnEvidence).toEqual(turnEvidence);
    expect(reconstruct.mock.calls[0]?.[0].turnEvidence).toEqual(turnEvidence);
    expect(capture.mock.calls[0]?.[0].turnEvidence).toEqual(turnEvidence);
  });

  it("copies outputs before an awaited capture can mutate a later privacy mode", async () => {
    const storageRoot = await root();
    const secondSubmission = post("run-second", "metadata");
    const reconstruct = vi.fn(async () => ({
      status: "ready" as const,
      outputs: [
        { eventId: "event-first", submission: post("run-first", "metadata") },
        { eventId: "event-second", submission: secondSubmission },
      ],
    }));
    const capture = vi.fn(async (input: LifecycleCaptureInput) => {
      if (input.eventId === "event-first") secondSubmission.privacyMode = "full";
      return published();
    });
    const reconstructionWorker = worker(storageRoot, "account-a", reconstruct, capture);
    await reconstructionWorker.enqueue(job("job-output-mutation", "metadata"));

    expect(await reconstructionWorker.drain()).toMatchObject({
      status: "drained",
      captured: 2,
      pending: 0,
    });
    expect(capture.mock.calls.map(([input]) => input.submission.privacyMode)).toEqual([
      "metadata",
      "metadata",
    ]);
  });

  it("drops expired jobs with a durable receipt before reconstruction", async () => {
    const storageRoot = await root();
    const reconstruct = vi.fn();
    const capture = vi.fn(async () => published());
    const reconstructionWorker = worker(storageRoot, "account-a", reconstruct, capture, {
      maxAgeMs: 100,
    });
    await reconstructionWorker.enqueue(job("job-expired"));
    const storedJob = (await jobStore(storageRoot).enumerate("claude-code", "session-1"))[0]!;

    expect(await reconstructionWorker.drain({ now: storedJob.capturedAtMs + 100 })).toMatchObject({
      status: "drained",
      dropped: 1,
      pending: 0,
    });
    expect(reconstruct).not.toHaveBeenCalled();
    await expect(
      jobStore(storageRoot).readOutcome(
        {
          integration: "claude-code",
          sessionId: "session-1",
          turnId: "turn-1",
          eventId: "job-expired",
        },
        "account-a",
      ),
    ).resolves.toMatchObject({
      status: "settled",
      receipt: { outcome: "dropped", reason: "expired" },
    });
  });

  it("drops the oldest pending job when reconstruction capacity is full", async () => {
    const storageRoot = await root();
    const reconstruct = vi.fn(async (value: ReconstructionJob) => ({
      status: "ready" as const,
      outputs: [{ eventId: `output-${value.eventId}`, submission: post(`run-${value.eventId}`) }],
    }));
    const capture = vi.fn(async () => published());
    const reconstructionWorker = worker(storageRoot, "account-a", reconstruct, capture, {
      maxEntries: 1,
    });
    await reconstructionWorker.enqueue(job("job-old"));
    await reconstructionWorker.enqueue(job("job-new"));

    expect(await reconstructionWorker.drain()).toMatchObject({
      status: "drained",
      captured: 1,
      dropped: 1,
      pending: 0,
    });
    expect(reconstruct.mock.calls.map(([value]) => value.eventId)).toEqual(["job-new"]);
    await expect(
      jobStore(storageRoot).readOutcome(
        {
          integration: "claude-code",
          sessionId: "session-1",
          turnId: "turn-1",
          eventId: "job-old",
        },
        "account-a",
      ),
    ).resolves.toMatchObject({
      status: "settled",
      receipt: { outcome: "dropped", reason: "capacity" },
    });
  });
});
