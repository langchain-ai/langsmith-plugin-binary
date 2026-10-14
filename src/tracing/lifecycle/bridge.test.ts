import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { LocalEndpoint } from "../../test-support/models/lifecycle.js";
import {
  expectNoFilesLeft,
  filesUnder,
  temporaryRoot,
} from "../../test-support/tracing/delivery.js";
import {
  CHILD_ID,
  ROOT_ID,
  SIBLING_ID,
  captureScope,
  localEndpoint,
  runPatch,
  runPost,
  save,
  turnEvidence,
  writerFor,
} from "../../test-support/tracing/lifecycle.js";
import { createLifecycleBridge } from "./index.js";
import type { LifecycleBridgeOptions } from "./models.js";

const PRIVATE = "lifecycle-private-content-marker";
let endpoint: LocalEndpoint;
let root: string;

beforeEach(async () => {
  endpoint = await localEndpoint();
  root = temporaryRoot();
});

afterEach(() => endpoint.close());

function bridge(options: Partial<LifecycleBridgeOptions> = {}) {
  return createLifecycleBridge({
    storageRoot: root,
    integration: "claude-code",
    sessionId: "session-1",
    writer: writerFor(endpoint.url),
    policy: { retryBaseMs: 0, quickRetryMs: 0 },
    ...options,
  });
}

const read = (turnId: string, eventId: string) =>
  createCaptureStore(root).read(captureScope("session-1", turnId, eventId));

it("keeps failed work for a recreated bridge to deliver later", async () => {
  const input = {
    turnId: "turn",
    eventId: "kept",
    submission: runPost("root"),
    turnEvidence: turnEvidence("open", []),
  };
  await expect(bridge().capture(input)).resolves.toMatchObject({ status: "published" });
  endpoint.failing.add(0);
  await expect(bridge().drain()).resolves.toMatchObject({ failed: 1, dropped: 0, pending: 1 });
  expect(Object.values((await read("turn", "kept"))!.delivery!.retries)).toMatchObject([
    { failures: 1 },
  ]);
  await expect(bridge().drain()).resolves.toMatchObject({ delivered: 1, pending: 0 });
});

it("delivers dependent creates and patches in prerequisite order and wakes after each", async () => {
  const wake = vi.fn();
  const lifecycle = bridge({ wake });
  const [parent, child, patch] = ["c-parent", "b-child", "a-patch"].map((eventId) =>
    captureScope("session-1", eventId === "c-parent" ? "turn-parent" : "turn-child", eventId),
  );
  await lifecycle.capture({
    ...patch!,
    submission: runPatch("child", { outputs: { result: "done" } }),
    turnEvidence: turnEvidence("authoritative", [], null),
    dependencies: [child!],
  });
  await lifecycle.capture({
    ...child!,
    submission: runPost("child"),
    turnEvidence: turnEvidence("open", [], null),
    dependencies: [parent!],
  });
  await lifecycle.capture({
    ...parent!,
    submission: runPost("root"),
    turnEvidence: turnEvidence("open", [CHILD_ID], null),
  });
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 3, pending: 0 });
  expect(endpoint.requests.map(({ method, payload }) => [method, payload["id"]])).toEqual([
    ["POST", ROOT_ID],
    ["POST", CHILD_ID],
    ["PATCH", CHILD_ID],
  ]);
  expect(endpoint.requests[1]?.payload).toMatchObject({
    trace_id: ROOT_ID,
    parent_run_id: ROOT_ID,
  });
  expect(wake).toHaveBeenCalledTimes(4);
});

it("defers captures until a native thread identity is available", async () => {
  const wake = vi.fn();
  const lifecycle = bridge({ wake });
  const input = { turnId: "turn", eventId: "event", turnEvidence: turnEvidence("open", []) };
  await expect(
    lifecycle.capture({ ...input, submission: runPost("root", { metadata: { threadId: " " } }) }),
  ).resolves.toEqual({ status: "deferred", reason: "missing-thread-identity" });
  expect(wake).not.toHaveBeenCalled();
  await expect(
    lifecycle.capture({
      ...input,
      submission: runPost("root", { metadata: { threadId: "t-42" } }),
    }),
  ).resolves.toMatchObject({ status: "published" });
  await expect(read("turn", "event")).resolves.toMatchObject({
    metadataProvenance: { threadId: "t-42" },
  });
  expect(wake).toHaveBeenCalledTimes(1);
});

it("snapshots its input and wake callback before asynchronous capture work", async () => {
  const wake = vi.fn();
  const late = vi.fn();
  const options: Partial<LifecycleBridgeOptions> = { wake };
  const lifecycle = bridge(options);
  options.wake = late;
  const submission = runPost("root", {
    privacyMode: "metadata",
    run: { inputs: { prompt: PRIVATE } },
  });
  const evidence = turnEvidence("open");
  const dependency = captureScope("session-1", "turn", "prerequisite");
  const pending = lifecycle.capture({
    turnId: "turn",
    eventId: "event",
    submission,
    turnEvidence: evidence,
    dependencies: [dependency],
  });
  submission.privacyMode = "full";
  submission.metadata.threadId = "mutated";
  evidence.childRunIds.push("mutated");
  dependency.eventId = "mutated";
  await expect(pending).resolves.toMatchObject({ status: "published" });
  const record = await read("turn", "event");
  expect(record).toMatchObject({
    normalizedPayload: { privacyMode: "metadata" },
    metadataProvenance: { threadId: "thread-1" },
    turnEvidence: { childRunIds: [CHILD_ID] },
    dependencies: [captureScope("session-1", "turn", "prerequisite")],
  });
  expect(JSON.stringify(record)).not.toContain(PRIVATE);
  expect([wake.mock.calls.length, late.mock.calls.length]).toEqual([1, 0]);
});

it("keeps an empty tag list on a muted post through capture and drain", async () => {
  const lifecycle = bridge();
  const muted = { privacyMode: "metadata" } as const;
  await lifecycle.capture({
    turnId: "turn",
    eventId: "empty-tags",
    submission: runPost("root", { ...muted, run: { tags: [] } }),
    turnEvidence: turnEvidence("open", [CHILD_ID], null),
  });
  await lifecycle.capture({
    turnId: "turn",
    eventId: "no-tags",
    submission: runPost("child", muted),
    turnEvidence: turnEvidence("open", [CHILD_ID], null),
  });
  await lifecycle.drain();
  const posts = endpoint.requests.filter(({ method }) => method === "POST");
  expect(posts.find(({ payload }) => payload["id"] === ROOT_ID)?.payload["tags"]).toEqual([]);
  expect(posts.find(({ payload }) => payload["id"] === CHILD_ID)?.payload).not.toHaveProperty(
    "tags",
  );
});

it("drops work past its age limit with a warning and clears old leftover files on drain", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const stray = join(
    root,
    "background-worker",
    "wake.active.11111111-0000-4000-8000-000000000000.json",
  );
  mkdirSync(join(root, "background-worker"));
  writeFileSync(stray, "{}");
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(stray, threeHoursAgo, threeHoursAgo);
  await bridge().capture({
    turnId: "turn",
    eventId: "old",
    submission: runPost("root"),
    turnEvidence: turnEvidence("open", []),
    sourceAgeStartedAtMs: Date.now() - 25 * 60 * 60 * 1000,
  });
  await expect(bridge().drain()).resolves.toMatchObject({ delivered: 0, dropped: 1, pending: 0 });
  expect(endpoint.requests).toHaveLength(0);
  expectNoFilesLeft(root);
  expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("never uploaded");
  warn.mockRestore();
});

it("keeps a settled turn while one of its saved events cannot be sent yet", async () => {
  const lifecycle = bridge();
  await lifecycle.capture({
    turnId: "turn",
    eventId: "root",
    submission: runPost("root"),
    turnEvidence: turnEvidence("authoritative", [], ROOT_ID),
  });
  const store = createCaptureStore(root);
  await store.capture({
    integration: "claude-code",
    sessionId: "session-1",
    turnId: "turn",
    eventId: "unsupported",
    runId: ROOT_ID,
    destinationFingerprint: lifecycle.accountFingerprint,
    eventKind: "unsupported-kind",
    normalizedPayload: {},
    turnEvidence: {},
    metadataProvenance: {},
  });
  await expect(lifecycle.drain()).resolves.toMatchObject({ pending: 1 });
  expect(filesUnder(root)).toHaveLength(2);
  await expect(store.read(captureScope("session-1", "turn", "root"))).resolves.toBeDefined();
});

it("sends a turn's new runs to LangSmith in one request", async () => {
  const lifecycle = bridge();
  await save(lifecycle, "turn", "root", runPost("root"));
  await save(lifecycle, "turn", "child", runPost("child"), turnEvidence(), [
    captureScope("session-1", "turn", "root"),
  ]);
  await save(lifecycle, "turn", "sibling", runPost("sibling"));
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 3, pending: 0 });
  expect(endpoint.httpRequests).toBe(1);
  expect(endpoint.requests.map(({ payload }) => payload["id"])).toEqual([
    ROOT_ID,
    CHILD_ID,
    SIBLING_ID,
  ]);
});

it("keeps every run of a failed request pending and sends them together again", async () => {
  const lifecycle = bridge();
  await save(lifecycle, "turn", "root", runPost("root"));
  await save(lifecycle, "turn", "child", runPost("child"), turnEvidence(), [
    captureScope("session-1", "turn", "root"),
  ]);
  endpoint.failing.add(0);
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 0, failed: 2, pending: 2 });
  for (const eventId of ["root", "child"])
    expect(Object.values((await read("turn", eventId))!.delivery!.retries)).toMatchObject([
      { failures: 1 },
    ]);
  expect(endpoint.httpRequests).toBe(1);
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 2, pending: 0 });
  expect(endpoint.httpRequests).toBe(2);
});
