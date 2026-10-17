import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import { eventPath } from "../../storage/capture/paths.js";
import type { StoredCapture } from "../../storage/capture/models.js";
import { expectNoFilesLeft, temporaryRoot } from "../../test-support/tracing/delivery.js";
import { ROOT_ID } from "../../test-support/constants.js";
import { localEndpoint, testBridge } from "../../test-support/tracing/lifecycle.js";
import { CaptureWakeError } from "../capture-wake.js";
import type { DeliveryPolicy } from "../delivery/models.js";
import type { LifecycleBridge, LifecycleCaptureInput } from "../lifecycle/models.js";
import type { PreparedRunPostSubmission } from "../upload/models.js";
import { CAPTURE_JOBS_DIRECTORY } from "../../storage/capture/constants.js";
import { createReconstructionWorker } from "./index.js";
import type { ReconstructionJob, ReconstructionJobInput, ReconstructionResult } from "./models.js";

const published = async () => ({ status: "published", record: {} as StoredCapture }) as const;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function job(eventId: string, privacyMode: "full" | "metadata" = "full"): ReconstructionJobInput {
  return {
    turnId: "turn-1",
    eventId,
    sourceRefs: [`snapshot-${eventId}`],
    privacyMode,
    turnEvidence: {
      rootRunId: "run-root",
      childRunIds: ["child-1"],
      closureState: "authoritative",
    },
  };
}

function post(id: string, privacyMode: "full" | "metadata" = "full"): PreparedRunPostSubmission {
  const metadata = {
    integration: "claude-code",
    threadId: "thread-1",
    agentType: "root",
    runType: "root",
  } as const;
  return {
    operation: "post",
    integration: "claude-code",
    privacyMode,
    metadata,
    run: { id, name: "run", run_type: "chain", inputs: {} },
  };
}

const ready = (...outputs: object[]) => ({ status: "ready", outputs }) as ReconstructionResult;

function worker(
  root: string,
  reconstruct: (value: ReconstructionJob) => Promise<ReconstructionResult> = vi.fn(),
  capture: LifecycleBridge["capture"] = vi.fn(published),
  policy: Partial<DeliveryPolicy> = {},
  accountFingerprint = "account-a",
) {
  return createReconstructionWorker({
    storageRoot: root,
    integration: "claude-code",
    sessionId: "session-1",
    bridge: { accountFingerprint, capture },
    reconstruct,
    policy: { retryBaseMs: 0, quickRetryMs: 0, ...policy },
  });
}

const jobs = (root: string) => createCaptureStore(root, CAPTURE_JOBS_DIRECTORY);
const jobScope = (eventId: string) => ({
  integration: "claude-code",
  sessionId: "session-1",
  turnId: "turn-1",
  eventId,
});
const receipt = (root: string, eventId: string) =>
  jobs(root).readOutcome(jobScope(eventId), "account-a");

it("answers a repeated job as a duplicate and a changed or foreign one as a conflict", async () => {
  const root = temporaryRoot();
  const accountA = worker(root);
  await expect(accountA.enqueue(job("job"))).resolves.toMatchObject({ status: "published" });
  await expect(accountA.enqueue(job("job"))).resolves.toMatchObject({ status: "duplicate" });
  await expect(accountA.enqueue({ ...job("job"), sourceRefs: ["changed"] })).resolves.toMatchObject(
    { status: "conflict" },
  );
  await expect(
    worker(root, undefined, undefined, {}, "account-b").enqueue(job("job")),
  ).resolves.toMatchObject({ status: "conflict" });
});

it("accepts a saved wake only for the job it was saved for", async () => {
  const root = temporaryRoot();
  const accountA = worker(root);
  const saved = await accountA.enqueue(job("job"));
  if (saved.status !== "published") throw new Error("Job was not saved");
  const wake = new CaptureWakeError(saved, new Error("launch failed"));
  await expect(accountA.readSavedWake(wake, job("job"))).resolves.toEqual(saved);
  await expect(
    accountA.readSavedWake(wake, { ...job("job"), sourceRefs: ["changed"] }),
  ).resolves.toBeUndefined();
});

it("refuses a saved wake whose job evidence was changed on disk", async () => {
  const root = temporaryRoot();
  const accountA = worker(root);
  const saved = await accountA.enqueue(job("job"));
  if (saved.status !== "published") throw new Error("Job was not saved");
  const wake = new CaptureWakeError(saved, new Error("launch failed"));
  const path = eventPath({ root, directory: CAPTURE_JOBS_DIRECTORY }, saved.record);
  await writeFile(
    path,
    JSON.stringify({ ...saved.record, turnEvidence: { childRunIds: [], closureState: "open" } }),
  );
  await expect(accountA.readSavedWake(wake, job("job"))).resolves.toBeUndefined();
});

it("rejects a job carrying fields the worker does not support", async () => {
  await expect(
    worker(temporaryRoot()).enqueue({
      ...job("bad"),
      transcript: "private",
    } as ReconstructionJobInput),
  ).rejects.toThrow("unsupported fields");
});

it("leaves work saved for another account pending without calling the callback", async () => {
  const root = temporaryRoot();
  const reconstruct = vi.fn();
  await worker(root).enqueue(job("job", "metadata"));
  const accountB = worker(root, reconstruct, vi.fn(published), {}, "account-b");
  await expect(accountB.drain()).resolves.toMatchObject({ pending: 1, accountMismatch: 1 });
  expect(reconstruct).not.toHaveBeenCalled();
});

it("defers a job that lacks thread identity and captures its outputs on the next pass", async () => {
  const root = temporaryRoot();
  const reconstruct = vi
    .fn()
    .mockResolvedValueOnce({ status: "deferred", reason: "missing-thread-identity" })
    .mockResolvedValue(ready({ eventId: "output", submission: post("run-output", "metadata") }));
  const capture = vi.fn<LifecycleBridge["capture"]>(published);
  const accountA = worker(root, reconstruct, capture);
  await accountA.enqueue(job("job", "metadata"));
  await expect(accountA.drain()).resolves.toMatchObject({ deferred: 1, failed: 0, pending: 1 });
  expect(reconstruct.mock.calls[0]?.[0].turnEvidence).toEqual(job("job").turnEvidence);
  await expect(accountA.drain()).resolves.toMatchObject({ captured: 1, pending: 0 });
  expect(capture.mock.calls[0]?.[0]).toMatchObject({
    turnId: "turn-1",
    eventId: "output",
    turnEvidence: job("job").turnEvidence,
  });
  await expect(receipt(root, "job")).resolves.toEqual({ status: "missing-capture" });
  expectNoFilesLeft(root);
});

it("keeps jobs whose callback or capture keeps failing and retries them", async () => {
  const root = temporaryRoot();
  const results: Record<string, unknown> = {
    "job-null": null,
    "job-status": { status: "unknown" },
    "job-deferred": { status: "deferred", reason: "unexpected" },
    "job-private": ready({
      eventId: "private",
      submission: {
        ...post("run-private"),
        run: { ...post("run-private").run, inputs: { prompt: "secret-marker" } },
      },
    }),
    "job-identity": ready({
      eventId: "identity",
      submission: post("run", "metadata"),
      turnEvidence: { rootRunId: "other", childRunIds: ["child-1"], closureState: "authoritative" },
    }),
    "job-evidence": ready({
      eventId: "evidence",
      submission: post("run", "metadata"),
      turnEvidence: {
        rootRunId: "run-root",
        childRunIds: ["child-1"],
        closureState: "authoritative",
        prompt: "x",
      },
    }),
  };
  const reconstruct = vi
    .fn()
    .mockRejectedValueOnce(new Error("interpretation failed"))
    .mockImplementation(async (value: ReconstructionJob) => results[value.eventId]);
  const capture = vi.fn<LifecycleBridge["capture"]>(published);
  const failing = worker(root, reconstruct, capture);
  for (const eventId of Object.keys(results)) await failing.enqueue(job(eventId, "metadata"));
  await expect(failing.drain()).resolves.toMatchObject({ failed: 6, dropped: 0, pending: 6 });
  await expect(failing.drain()).resolves.toMatchObject({ failed: 6, dropped: 0, pending: 6 });
  expect(capture).not.toHaveBeenCalled();
  await expect(receipt(root, "job-null")).resolves.toMatchObject({ status: "pending" });
  const nullCapture = worker(
    root,
    vi.fn(async () => ready({ eventId: "out", submission: post("run-out") })),
    vi.fn(async () => null as never),
  );
  await nullCapture.enqueue(job("job-null-capture"));
  await expect(nullCapture.drain()).resolves.toMatchObject({ dropped: 0 });
  const files = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  for (const file of files.filter((entry) => entry.isFile()))
    expect(await readFile(join(file.parentPath, file.name), "utf8")).not.toContain("secret-marker");
});

it("snapshots the account, policy and outputs before callbacks can change them", async () => {
  const root = temporaryRoot();
  const later = post("run-later", "metadata");
  const reconstruct = vi.fn(async (value: ReconstructionJob) => {
    try {
      (value as { privacyMode: string }).privacyMode = "full";
    } catch {}
    return ready(
      { eventId: "first", submission: post("run-first", "metadata") },
      { eventId: "later", submission: later },
    );
  });
  const capture = vi.fn(async (input: LifecycleCaptureInput) => {
    later.privacyMode = "full";
    void input;
    return published();
  });
  const options = {
    storageRoot: root,
    integration: "claude-code" as const,
    sessionId: "session-1",
    bridge: { accountFingerprint: "account-a", capture },
    reconstruct,
  };
  const snapshotting = createReconstructionWorker(options);
  options.bridge = { accountFingerprint: "account-b", capture: vi.fn() };
  await snapshotting.enqueue(job("job", "metadata"));
  await expect(snapshotting.drain()).resolves.toMatchObject({ captured: 2, pending: 0 });
  expect(capture.mock.calls.map(([input]) => input.submission.privacyMode)).toEqual([
    "metadata",
    "metadata",
  ]);
});

it("drops expired and over-capacity jobs before reconstruction runs", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const root = temporaryRoot();
  const reconstruct = vi.fn(async (value: ReconstructionJob) =>
    ready({ eventId: `out-${value.eventId}`, submission: post(`run-${value.eventId}`) }),
  );
  const bounded = worker(root, reconstruct, vi.fn(published), { maxEntries: 1, maxAgeMs: 60_000 });
  await bounded.enqueue({ ...job("expired"), sourceAgeStartedAtMs: Date.now() - 60_000 });
  await bounded.enqueue(job("old"));
  await bounded.enqueue(job("new"));
  await expect(bounded.drain()).resolves.toMatchObject({ captured: 1, dropped: 2, pending: 0 });
  expect(reconstruct.mock.calls.map(([value]) => value.eventId)).toEqual(["new"]);
  await expect(receipt(root, "expired")).resolves.toEqual({ status: "missing-capture" });
  await expect(receipt(root, "old")).resolves.toEqual({ status: "missing-capture" });
  expect(warn).toHaveBeenCalledTimes(2);
});

function snapshotJob(
  eventId: string,
  privacyMode: "full" | "metadata",
  ages: number[],
  context?: object,
): ReconstructionJobInput {
  const refs = ages.map((_, index) => `source-${index}`);
  const sourceSnapshots = ages.map((age, index) => {
    const submission = post(`2222222${index}-2222-4222-8222-222222222222`, privacyMode);
    submission.run.start_time = age;
    return {
      sourceRef: refs[index]!,
      submission,
      sourceAgeStartedAtMs: age,
      ...(context === undefined ? {} : { attributionContext: context }),
    };
  });
  return {
    ...job(eventId, privacyMode),
    sourceRefs: refs,
    sourceSnapshots,
  } as ReconstructionJobInput;
}

function snapshotIntake() {
  const intake = worker(temporaryRoot());
  const now = Date.now();
  const valid = snapshotJob("job", "full", [now]);
  return { intake, now, valid };
}

it("rejects unsafe snapshot envelopes", async () => {
  const { intake, now, valid } = snapshotIntake();
  const missingTime = snapshotJob("missing-time", "full", [now]);
  delete (missingTime.sourceSnapshots![0]!.submission.run as { start_time?: unknown }).start_time;
  const invalid: [ReconstructionJobInput, string][] = [
    [missingTime, "preserve their start time"],
    [snapshotJob("fraction", "full", [1.5]), "Source age"],
    [{ ...valid, sourceRefs: ["source-0", "unmatched"] }, "cover every reconstruction source ref"],
    [
      {
        ...valid,
        sourceRefs: ["/private/path"],
        sourceSnapshots: [{ ...valid.sourceSnapshots![0]!, sourceRef: "/private/path" }],
      },
      "pathless identifiers",
    ],
  ];
  for (const [input, message] of invalid)
    await expect(intake.enqueue(input)).rejects.toThrow(message);
});

it("keeps snapshot age fixed on later duplicates", async () => {
  const { intake, now, valid } = snapshotIntake();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await expect(intake.enqueue(valid)).resolves.toMatchObject({ status: "published" });
  clock.mockReturnValue(now + 60_000);
  await expect(intake.enqueue(valid)).resolves.toMatchObject({ status: "duplicate" });
  clock.mockRestore();
  const shifted = {
    ...valid,
    sourceSnapshots: [{ ...valid.sourceSnapshots![0]!, sourceAgeStartedAtMs: now + 1 }],
  };
  await expect(intake.enqueue(shifted)).resolves.toMatchObject({ status: "conflict" });
});

it("projects snapshot attribution context by privacy mode", async () => {
  const root = temporaryRoot();
  const marker = "private-snapshot-marker";
  const context = {
    toolOrigin: { path: `/${marker}`, cwd: `/${marker}`, namedAPath: true },
    pinnedRepositoryKeys: [marker],
  };
  const seen: ReconstructionJob[] = [];
  const capture = vi.fn<LifecycleBridge["capture"]>(published);
  const reconstruct = vi.fn(async (value: ReconstructionJob) => {
    seen.push(value);
    return ready({
      eventId: `out-${value.eventId}`,
      sourceRef: "source-0",
      submission: post(`run-${value.eventId}`, value.privacyMode),
    });
  });
  const snapshots = worker(root, reconstruct, capture);
  const age = Date.now() - 1_000;
  const metadataJob = snapshotJob("metadata-job", "metadata", [age], context);
  (metadataJob.sourceSnapshots![0]!.submission.run as { inputs: object }).inputs = {
    prompt: marker,
  };
  await snapshots.enqueue(metadataJob);
  await snapshots.enqueue(snapshotJob("full-job", "full", [age], context));
  await expect(snapshots.drain()).resolves.toMatchObject({ captured: 2 });
  expect(Object.isFrozen(seen[0]?.sourceSnapshots)).toBe(true);
  expect(seen.map((value) => value.sourceSnapshots?.[0]?.attributionContext)).toEqual([
    { toolOrigin: { namedAPath: true } },
    context,
  ]);
  expect(JSON.stringify(seen[0])).not.toContain(marker);
  expect(capture.mock.calls[0]?.[0].sourceAgeStartedAtMs).toBe(age);
});

it("expires stale snapshot sources individually while uploading fresh ones", async () => {
  const root = temporaryRoot();
  const endpoint = await localEndpoint();
  cleanups.push(endpoint.close);
  const lifecycle = testBridge(root, endpoint.url, { policy: { maxAgeMs: 60_000 } });
  const now = Date.now();
  const outputs = [0, 1].map((index) => ({
    eventId: `out-${index}`,
    sourceRef: `source-${index}`,
    submission: post(`1111111${index}-1111-4111-8111-111111111111`),
  }));
  const reconstruct = vi.fn(async () => ready(...outputs));
  const mixed = worker(
    root,
    reconstruct,
    lifecycle.capture,
    { maxAgeMs: 60_000 },
    lifecycle.accountFingerprint,
  );
  await mixed.enqueue(snapshotJob("mixed", "full", [now - 120_000, now - 1_000]));
  await mixed.enqueue(snapshotJob("expired", "full", [now - 120_000]));
  await expect(mixed.drain({ now })).resolves.toMatchObject({
    captured: 2,
    dropped: 1,
    pending: 0,
  });
  await expect(lifecycle.drain({ now })).resolves.toMatchObject({ delivered: 1, dropped: 1 });
  expect(endpoint.requests.map(({ payload }) => payload["id"])).toEqual([
    outputs[1]!.submission.run.id,
  ]);
  expect(reconstruct).toHaveBeenCalledTimes(1);
});

it("completes a job whose rebuild has nothing to send", async () => {
  const root = temporaryRoot();
  const capture = vi.fn<LifecycleBridge["capture"]>(published);
  const quiet = worker(
    root,
    vi.fn(async () => ready()),
    capture,
  );
  await quiet.enqueue(job("job-empty"));
  await expect(quiet.drain()).resolves.toMatchObject({ failed: 0, pending: 0 });
  expect(capture).not.toHaveBeenCalled();
  await expect(jobs(root).read(jobScope("job-empty"))).resolves.toBeUndefined();
});

it("removes delivered snapshot jobs, including one delivered before the drain", async () => {
  const root = temporaryRoot();
  const now = Date.now();
  const reconstruct = vi.fn(async () =>
    ready({ eventId: "out", sourceRef: "source-0", submission: post("run-out") }),
  );
  const cleaning = worker(root, reconstruct);
  await cleaning.enqueue(snapshotJob("delivered-early", "full", [now]));
  await jobs(root).recordOutcome({
    ...jobScope("delivered-early"),
    destination: "account-a",
    outcome: "delivered",
  });
  await cleaning.enqueue(snapshotJob("cleaned", "full", [now]));
  await expect(cleaning.drain({ now })).resolves.toMatchObject({ captured: 1, pending: 0 });
  expect(reconstruct).toHaveBeenCalledTimes(1);
  for (const eventId of ["delivered-early", "cleaned"])
    await expect(jobs(root).read(jobScope(eventId))).resolves.toBeUndefined();
  expectNoFilesLeft(root);
});

async function savedMappingAfterFirstPass() {
  const root = temporaryRoot();
  const evidence = {
    rootRunId: "run-root",
    childRunIds: ["child-1", "discovered"],
    closureState: "authoritative",
  };
  const dependencies = [{ ...jobScope("prerequisite"), turnId: "turn-0" }];
  const reconstruct = vi.fn(async () =>
    ready(
      { eventId: "root", submission: post("run-root"), turnEvidence: evidence, dependencies },
      { eventId: "child", sourceRef: "snapshot-job", submission: post("run-child") },
    ),
  );
  const deferChild = vi.fn(async (input: LifecycleCaptureInput) =>
    input.eventId === "child"
      ? ({ status: "deferred", reason: "missing-thread-identity" } as const)
      : published(),
  );
  await worker(root, reconstruct, deferChild).enqueue(job("job"));
  await expect(worker(root, reconstruct, deferChild).drain()).resolves.toMatchObject({
    captured: 1,
    deferred: 1,
    pending: 1,
  });
  return { root, evidence, dependencies, reconstruct, deferChild };
}

it("replays a saved output mapping after a restart", async () => {
  const { root, evidence, dependencies, reconstruct, deferChild } =
    await savedMappingAfterFirstPass();
  expect(deferChild.mock.calls[0]?.[0]).toMatchObject({ turnEvidence: evidence, dependencies });
  await expect(worker(root, reconstruct, vi.fn(published)).drain()).resolves.toMatchObject({
    captured: 2,
    pending: 0,
  });
});

it("rejects a replay whose reconstructed evidence changed", async () => {
  const { root, evidence, reconstruct } = await savedMappingAfterFirstPass();
  const replay = vi.fn(published);
  evidence.childRunIds.push("changed");
  await expect(worker(root, reconstruct, replay).drain()).resolves.toMatchObject({
    failed: 1,
    captured: 0,
  });
  expect(replay).not.toHaveBeenCalled();
});

it("fails an output that depends on itself", async () => {
  const self = ready({
    eventId: "self",
    submission: post("run-self"),
    dependencies: [jobScope("self")],
  });
  const selfDependent = worker(
    temporaryRoot(),
    vi.fn(async () => self),
    vi.fn(published),
  );
  await selfDependent.enqueue(job("self-job"));
  await expect(selfDependent.drain()).resolves.toMatchObject({ failed: 1, dropped: 0, pending: 1 });
});

const reconstructRedacted = async (value: ReconstructionJob) =>
  ready({
    eventId: "patch",
    sourceRef: "source",
    submission: value.sourceSnapshots![0]!.submission,
  });

it("keeps field redaction through saved captures and a reconstruction restart", async () => {
  const root = temporaryRoot();
  const endpoint = await localEndpoint();
  cleanups.push(endpoint.close);
  const replaced = "private-marker-replaced";
  const writer = {
    destinations: [{ apiKey: "synthetic-key", apiUrl: endpoint.url, projectName: "p" }],
    redact: true,
    redactExtraRules: [{ pattern: "private-marker", replace: replaced }],
  };
  const bridge = testBridge(root, endpoint.url, { writer });
  const source = post(ROOT_ID);
  Object.assign(source.run, {
    start_time: "2026-10-10T12:00:00.000Z",
    trace_id: source.run.id,
    dotted_order: `20261010T120000000000Z${source.run.id}`,
    inputs: { value: replaced },
  });
  await bridge.capture({
    turnId: "turn-1",
    eventId: "post",
    submission: { ...source, redactedFields: ["inputs"] },
    turnEvidence: { childRunIds: [], closureState: "open" },
  });
  const { inputs: _inputs, ...context } = source.run;
  void _inputs;
  const patch = {
    ...source,
    operation: "patch",
    redactedFields: ["outputs"],
    privacyContext: { status: "running" },
    run: context,
    patch: { fields: ["outputs"], values: { outputs: { value: replaced } } },
  };
  const snapshot = {
    ...job("job"),
    sourceRefs: ["source"],
    sourceSnapshots: [{ sourceRef: "source", sourceAgeStartedAtMs: Date.now(), submission: patch }],
  } as ReconstructionJobInput;
  await worker(root, reconstructRedacted, bridge.capture, {}, bridge.accountFingerprint).enqueue(
    snapshot,
  );
  const resumed = testBridge(root, endpoint.url, { writer });
  await resumed.drain();
  await expect(
    worker(root, reconstructRedacted, resumed.capture, {}, resumed.accountFingerprint).drain(),
  ).resolves.toMatchObject({ captured: 1 });
  await resumed.drain();
  expect(endpoint.requests.map(({ payload }) => payload["inputs"] ?? payload["outputs"])).toEqual([
    { value: replaced },
    { value: replaced },
  ]);
});

it("does not retry a failed job before its backoff has passed", async () => {
  const root = temporaryRoot();
  const reconstruct = vi.fn().mockRejectedValue(new Error("interpretation failed"));
  const retrying = worker(root, reconstruct, undefined, { retryBaseMs: 60_000 });
  await retrying.enqueue(job("job"));
  await expect(retrying.drain()).resolves.toMatchObject({ failed: 1, deferred: 0, pending: 1 });
  await expect(retrying.drain()).resolves.toMatchObject({ failed: 0, deferred: 1, pending: 1 });
  expect(reconstruct).toHaveBeenCalledTimes(1);
});

it("reports the earliest retry time among pending jobs", async () => {
  const root = temporaryRoot();
  let current = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => current);
  let secondPass = false;
  const reconstruct = vi.fn(async (value: ReconstructionJob): Promise<ReconstructionResult> => {
    if (secondPass && value.eventId === "second")
      return { status: "deferred", reason: "missing-thread-identity" };
    throw new Error("interpretation failed");
  });
  const retrying = worker(root, reconstruct, undefined, { retryBaseMs: 1_000 });
  await retrying.enqueue(job("first"));
  current += 1;
  await retrying.enqueue(job("second"));
  await retrying.drain();
  secondPass = true;
  current = 1_002_000;
  await expect(retrying.drain()).resolves.toMatchObject({
    failed: 1,
    deferred: 1,
    nextRetryAtMs: 1_001_001,
  });
});

it("keeps jobs with the same event ID in different turns separate in the flat jobs folder", async () => {
  const root = temporaryRoot();
  const capture = vi.fn<LifecycleBridge["capture"]>(published);
  const reconstruct = vi.fn(async (value: ReconstructionJob) =>
    ready({ eventId: "output", submission: post(`run-${value.turnId}`) }),
  );
  const rebuilding = worker(root, reconstruct, capture);
  for (const turnId of ["turn-a", "turn-b"])
    await expect(rebuilding.enqueue({ ...job("shared-event"), turnId })).resolves.toMatchObject({
      status: "published",
    });
  const store = jobs(root);
  expect(await store.enumerate("claude-code", "session-1")).toHaveLength(2);
  expect(await store.enumerateTurn("claude-code", "session-1", "turn-a")).toHaveLength(1);
  await expect(rebuilding.drain()).resolves.toMatchObject({ captured: 2, pending: 0 });
  expect(capture.mock.calls.map(([input]) => input.turnId).toSorted()).toEqual([
    "turn-a",
    "turn-b",
  ]);
  expectNoFilesLeft(root);
});
