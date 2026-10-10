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
  ReconstructionAttributionContext,
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

function post(
  id: string,
  privacyMode: "full" | "metadata" = "full",
  integration: PreparedRunPostSubmission["integration"] = "claude-code",
): PreparedRunPostSubmission {
  return {
    operation: "post",
    integration,
    privacyMode,
    metadata: {
      integration,
      threadId: "thread-1",
      agentType: "root",
      runType: "root",
    },
    run: { id, name: "test run", run_type: "chain", inputs: { prompt: "safe" } },
  };
}

function snapshotJob(
  eventId: string,
  privacyMode: "full" | "metadata",
  sourceRef: string,
  sourceAgeStartedAtMs: number,
  submission: PreparedRunPostSubmission,
  attributionContext?: ReconstructionAttributionContext,
) {
  return {
    ...job(eventId, privacyMode),
    sourceRefs: [sourceRef],
    sourceSnapshots: [
      {
        sourceRef,
        submission,
        sourceAgeStartedAtMs,
        ...(attributionContext === undefined ? {} : { attributionContext }),
      },
    ],
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
  integration: ReconstructionWorkerOptions["integration"] = "claude-code",
) {
  return createReconstructionWorker({
    storageRoot,
    integration,
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

  it("projects metadata snapshots and carries their original age to output captures", async () => {
    const storageRoot = await root();
    const sourceRef = "source-metadata";
    const privateMarker = "private-snapshot-marker";
    const sourceAgeStartedAtMs = Date.now() - 1_000;
    const submission = post("source-run", "metadata");
    submission.run.start_time = Date.now();
    submission.run.inputs = { prompt: privateMarker };
    const attributionContext = {
      toolOrigin: {
        path: `/${privateMarker}/path`,
        cwd: `/${privateMarker}/cwd`,
        namedAPath: true,
      },
      pinnedRepositoryKeys: [privateMarker],
    };
    const reconstruct = vi.fn(async (value: ReconstructionJob) => {
      const snapshot = value.sourceSnapshots?.[0];
      expect(Object.isFrozen(value.sourceSnapshots)).toBe(true);
      expect(snapshot?.submission.run.id).toBe("source-run");
      expect(JSON.stringify(snapshot)).not.toContain(privateMarker);
      expect(snapshot?.attributionContext).toEqual({ toolOrigin: { namedAPath: true } });
      return {
        status: "ready" as const,
        outputs: [
          { eventId: "output-source", sourceRef, submission: post("output-run", "metadata") },
        ],
      };
    });
    const capture = vi.fn<ReconstructionWorkerOptions["bridge"]["capture"]>(async () =>
      published(),
    );
    const reconstructionWorker = worker(storageRoot, "account-a", reconstruct, capture);
    await reconstructionWorker.enqueue(
      snapshotJob(
        "job-source",
        "metadata",
        sourceRef,
        sourceAgeStartedAtMs,
        submission,
        attributionContext,
      ),
    );
    submission.run.id = "mutated-source";
    expect(await reconstructionWorker.drain()).toMatchObject({ status: "drained", captured: 1 });
    expect(capture.mock.calls[0]?.[0].sourceAgeStartedAtMs).toBe(sourceAgeStartedAtMs);
    expect(JSON.stringify(await contents(storageRoot))).not.toContain(privateMarker);
  });

  it.each(["cursor", "openai-codex"] as const)(
    "keeps full attribution context for %s snapshots",
    async (integration) => {
      const storageRoot = await root();
      const contexts: ReconstructionAttributionContext[] = [
        { toolOrigin: { path: "/workspace", cwd: "/workspace", namedAPath: false } },
        {
          toolOrigin: { path: "/repository", cwd: "/repository", namedAPath: true },
          pinnedRepositoryKeys: [],
        },
      ];
      const seen: (ReconstructionAttributionContext | undefined)[] = [];
      const reconstruct = vi.fn(async (value: ReconstructionJob) => {
        seen.push(value.sourceSnapshots?.[0]?.attributionContext);
        return { status: "deferred" as const, reason: "missing-thread-identity" as const };
      });
      const reconstructionWorker = worker(
        storageRoot,
        "account-a",
        reconstruct,
        vi.fn(async () => published()),
        {},
        integration,
      );
      for (const [index, context] of contexts.entries()) {
        const submission = post(`source-${index}`, "full", integration);
        submission.run.start_time = Date.now();
        await reconstructionWorker.enqueue(
          snapshotJob(`job-${index}`, "full", `source-${index}`, Date.now(), submission, context),
        );
      }
      expect(await reconstructionWorker.drain()).toMatchObject({ status: "drained", deferred: 2 });
      expect(seen).toEqual(contexts);
    },
  );

  it("keeps snapshot age immutable across duplicate enqueues at later times", async () => {
    const storageRoot = await root();
    const reconstruct = vi.fn();
    const reconstructionWorker = worker(
      storageRoot,
      "account-a",
      reconstruct,
      vi.fn(async () => published()),
    );
    const sourceRef = "source-duplicate";
    const submittedAt = Date.now();
    const sourceAgeStartedAtMs = submittedAt - 1_000;
    const submission = post("source-run", "full");
    submission.run.start_time = submittedAt;
    const originalNow = vi.spyOn(Date, "now").mockReturnValue(submittedAt);
    try {
      const input = snapshotJob(
        "job-duplicate",
        "full",
        sourceRef,
        sourceAgeStartedAtMs,
        submission,
      );
      expect((await reconstructionWorker.enqueue(input)).status).toBe("published");
      originalNow.mockReturnValue(submittedAt + 60_000);
      expect((await reconstructionWorker.enqueue(input)).status).toBe("duplicate");
      expect(
        (
          await reconstructionWorker.enqueue(
            snapshotJob("job-duplicate", "full", sourceRef, sourceAgeStartedAtMs + 1, submission),
          )
        ).status,
      ).toBe("conflict");
    } finally {
      originalNow.mockRestore();
    }
  });

  it("rejects unstable, incomplete, or unsafe source snapshot envelopes", async () => {
    const storageRoot = await root();
    const reconstructionWorker = worker(
      storageRoot,
      "account-a",
      vi.fn(),
      vi.fn(async () => published()),
    );
    const age = Date.now();
    const stable = post("stable", "full");
    stable.run.start_time = age;
    const missingTime = post("missing-time", "full");
    const invalidInputs = [
      [
        snapshotJob("job-missing-time", "full", "source-missing-time", age, missingTime),
        "preserve their start time",
      ],
      [
        snapshotJob("job-fractional-age", "full", "source-fractional-age", 1.5, stable),
        "Source age",
      ],
      [
        {
          ...snapshotJob("job-partial", "full", "source-known", age, stable),
          sourceRefs: ["source-known", "source-unmatched"],
        },
        "cover every reconstruction source ref",
      ],
      [snapshotJob("job-path", "full", "/private/path", age, stable), "pathless identifiers"],
    ] as const;
    for (const [input, message] of invalidInputs)
      await expect(reconstructionWorker.enqueue(input)).rejects.toThrow(message);
  });

  it("expires snapshot jobs using the original source age", async () => {
    const storageRoot = await root();
    const now = Date.now();
    const sourceAgeStartedAtMs = now - 200;
    const submission = post("source-old", "full");
    submission.run.start_time = now;
    const reconstruct = vi.fn();
    const reconstructionWorker = worker(
      storageRoot,
      "account-a",
      reconstruct,
      vi.fn(async () => published()),
      { maxAgeMs: 100 },
    );
    await reconstructionWorker.enqueue(
      snapshotJob("job-old-source", "full", "source-old", sourceAgeStartedAtMs, submission),
    );
    expect(await reconstructionWorker.drain({ now })).toMatchObject({
      status: "drained",
      dropped: 1,
      pending: 0,
    });
    expect(reconstruct).not.toHaveBeenCalled();
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
