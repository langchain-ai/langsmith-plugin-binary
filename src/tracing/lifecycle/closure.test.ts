import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import { eventPath } from "../../storage/capture/paths.js";
import type { LocalEndpoint } from "../../test-support/models/lifecycle.js";
import {
  expectNoFilesLeft,
  filesUnder,
  recordFilesUnder,
  temporaryRoot,
} from "../../test-support/tracing/delivery.js";
import {
  CHILD_ID,
  REPOSITORY,
  ROOT_ID,
  SIBLING_ID,
  captureScope,
  localEndpoint,
  runPatch,
  runPost,
  save,
  testBridge,
  turnEvidence,
  writerFor,
} from "../../test-support/tracing/lifecycle.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import type { LifecycleBridgeOptions } from "./models.js";

const END = "2026-10-10T12:00:01.000Z";
const CHILD_END = "2026-10-10T12:00:00.900Z";
const OWNER = { repository_name: "acme/project", ls_attribution_identifier: "Owner" };
const subagent = { metadata: { runType: "subagent" as const }, privacyMode: "metadata" as const };
let endpoint: LocalEndpoint;
let root: string;

beforeEach(async () => {
  endpoint = await localEndpoint();
  root = temporaryRoot();
});

afterEach(() => endpoint.close());

const bridge = (options: Partial<LifecycleBridgeOptions> = {}) =>
  testBridge(root, endpoint.url, options);
const scope = (turnId: string, eventId: string) => captureScope("session-1", turnId, eventId);
const calls = (from = 0) =>
  endpoint.requests.slice(from).map(({ method, path }) => `${method} ${path.split("/").at(-1)}`);
const endTimes = (from = 0) =>
  endpoint.requests.slice(from).map(({ payload }) => payload["end_time"]);
const metadataOf = (index: number) => endpoint.requests[index]?.payload["extra"];
const records = async () => createCaptureStore(root).enumerate("claude-code", "session-1");

async function rootAndChild(
  lifecycle = bridge(),
  rootOptions: Parameters<typeof runPost>[1] = {},
  childOptions: Parameters<typeof runPost>[1] = {},
) {
  await save(lifecycle, "turn", "root", runPost("root", rootOptions));
  await save(lifecycle, "turn", "child", runPost("child", childOptions), turnEvidence(), [
    scope("turn", "root"),
  ]);
  return lifecycle;
}

it("adds root repository metadata to a completed child through a settlement patch", async () => {
  const lifecycle = await rootAndChild(bridge(), { base: REPOSITORY }, { run: { end_time: END } });
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 3, pending: 0 });
  expect(calls()).toEqual(["POST runs", "POST runs", `PATCH ${CHILD_ID}`]);
  expect(endTimes()).toEqual([undefined, undefined, END]);
  expect(metadataOf(2)).toMatchObject({ metadata: REPOSITORY });
});

it("counts work saved for another account in the result of a settled drain", async () => {
  const other = bridge({ writer: writerFor(endpoint.url, "synthetic-other-key") });
  await save(other, "other-turn", "other", runPost("sibling"));
  const lifecycle = await rootAndChild(bridge(), { base: REPOSITORY }, { run: { end_time: END } });
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 3, accountMismatch: 1 });
});

it("withholds a parent end time until a child from another turn is delivered", async () => {
  const lifecycle = bridge();
  const child = runPost("child", { ...subagent, base: OWNER, run: { end_time: CHILD_END } });
  await save(
    lifecycle,
    "parent",
    "root",
    runPost("root", { privacyMode: "metadata", run: { end_time: END } }),
  );
  await save(lifecycle, "child-turn", "child", child, turnEvidence("authoritative", [], CHILD_ID), [
    scope("parent", "root"),
  ]);
  endpoint.failing.add(0);
  await lifecycle.drain();
  expect(calls()).toEqual(["POST runs", "POST runs"]);
  expect(endTimes()).toEqual([undefined, CHILD_END]);
  await expect(lifecycle.drain()).resolves.toMatchObject({ pending: 0 });
  expect(calls(2)).toEqual(["POST runs", "POST runs", `PATCH ${ROOT_ID}`]);
  expect(endTimes(2)).toEqual([undefined, CHILD_END, END]);
});

it("keeps a parent end time when its child from another turn was already delivered", async () => {
  const lifecycle = bridge();
  const child = runPost("child", { ...subagent, run: { end_time: CHILD_END } });
  await save(lifecycle, "child-turn", "child", child, turnEvidence("authoritative", [], CHILD_ID));
  await lifecycle.drain();
  await save(
    lifecycle,
    "parent",
    "root",
    runPost("root", { privacyMode: "metadata", run: { end_time: END } }),
  );
  await lifecycle.drain();
  expect(endpoint.requests[1]?.payload).toMatchObject({ id: ROOT_ID, end_time: END });
});

it("keeps a root open until its child has been delivered", async () => {
  const lifecycle = await rootAndChild(bridge(), {
    base: { repository_name: "acme/project" },
    run: { end_time: END },
  });
  endpoint.failing.add(0);
  await expect(lifecycle.drain()).resolves.toMatchObject({ failed: 2 });
  expect(endTimes(0).slice(0, 2)).toEqual([undefined, undefined]);
  const revision = runPatch(
    "root",
    { end_time: END },
    { base: { repository_name: "acme/project" } },
  );
  await save(lifecycle, "turn", "root-end", revision, turnEvidence(), [scope("turn", "root")]);
  endpoint.failing.clear();
  await lifecycle.drain();
  const units = endpoint.requests;
  const lastChildPost = units.findLastIndex(
    ({ method, payload }) => method === "POST" && payload["id"] === CHILD_ID,
  );
  const firstEndTime = units.findIndex(
    ({ method, path, payload }) =>
      method === "PATCH" && path.endsWith(ROOT_ID) && payload["end_time"] === END,
  );
  expect(firstEndTime).toBeGreaterThan(lastChildPost);
});

it("still sends a root end time after a tool post was rejected for good", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  endpoint.rejectedIds.add(CHILD_ID);
  const lifecycle = await rootAndChild(
    bridge(),
    { base: { repository_name: "acme/project" }, run: { end_time: END } },
    { metadata: { runType: "tool" }, run: { end_time: CHILD_END } },
  );
  for (let pass = 0; pass < 3; pass += 1) await lifecycle.drain();
  expect(
    endpoint.requests.some(
      ({ method, path, payload }) =>
        method === "PATCH" && path.endsWith(ROOT_ID) && payload["end_time"] === END,
    ),
  ).toBe(true);
  warn.mockRestore();
});

it("sends a late update for a run whose delivered turn was already removed", async () => {
  const lifecycle = bridge();
  await save(
    lifecycle,
    "turn",
    "root",
    runPost("root", { base: OWNER, run: { end_time: END } }),
    turnEvidence("authoritative", [], ROOT_ID),
  );
  await lifecycle.drain();
  expect(recordFilesUnder(root)).toEqual([]);
  const sent = endpoint.requests.length;
  await save(
    lifecycle,
    "turn",
    "late",
    runPatch("root", { end_time: CHILD_END }, { base: OWNER }),
    turnEvidence("authoritative", [], ROOT_ID),
    [scope("turn", "root")],
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + GRACE_MS);
  try {
    await lifecycle.drain();
  } finally {
    clock.mockRestore();
  }
  expect(endpoint.requests.length).toBeGreaterThan(sent);
});

it("ends a child that arrives after its turn settled and gives it the turn's metadata", async () => {
  const lifecycle = await rootAndChild(
    bridge(),
    { base: OWNER, run: { end_time: END } },
    { metadata: { runType: "tool" }, run: { end_time: CHILD_END } },
  );
  for (let pass = 0; pass < 3; pass += 1) await lifecycle.drain();
  expect(recordFilesUnder(root)).toEqual([]);
  const sent = endpoint.requests.length;
  await save(
    lifecycle,
    "turn",
    "late-child",
    runPost("sibling", { metadata: { runType: "tool" }, run: { end_time: CHILD_END } }),
    turnEvidence(),
    [scope("turn", "root")],
  );
  for (let pass = 0; pass < 3; pass += 1) await lifecycle.drain();
  const lateRequests = endpoint.requests.slice(sent);
  expect(lateRequests.length).toBeGreaterThan(0);
  expect(
    lateRequests.some(
      ({ payload }) =>
        payload["end_time"] === CHILD_END &&
        JSON.stringify(payload["extra"]).includes("acme/project"),
    ),
  ).toBe(true);
});

it("settles a turn that never closed after two quiet hours and warns once", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const lifecycle = bridge();
  await save(lifecycle, "turn", "root", runPost("root", { base: OWNER }), turnEvidence("open"));
  await save(
    lifecycle,
    "turn",
    "child",
    runPost("child", { metadata: { runType: "tool" }, run: { end_time: CHILD_END } }),
    turnEvidence("open"),
    [scope("turn", "root")],
  );
  await lifecycle.drain();
  const sent = endpoint.requests.length;
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60 * 1000 + 1000);
  try {
    for (let pass = 0; pass < 3; pass += 1) await lifecycle.drain();
  } finally {
    clock.mockRestore();
  }
  expect(
    endpoint.requests
      .slice(sent)
      .some(({ payload }) => JSON.stringify(payload["extra"]).includes("Owner")),
  ).toBe(true);
  expect(
    warn.mock.calls.filter(([message]) => String(message).includes("never ended")),
  ).toHaveLength(1);
  warn.mockRestore();
});

it("leaves one marker per removed turn and none a day later", async () => {
  const lifecycle = bridge();
  for (let turn = 0; turn < 3; turn += 1) {
    await save(
      lifecycle,
      `turn-${turn}`,
      "root",
      runPost("root", { base: OWNER, run: { end_time: END } }),
      turnEvidence("authoritative", [], ROOT_ID),
    );
    await save(
      lifecycle,
      `turn-${turn}`,
      "late",
      runPatch("root", { end_time: CHILD_END }, { base: OWNER }),
      turnEvidence("authoritative", [], ROOT_ID),
      [scope(`turn-${turn}`, "root")],
    );
  }
  await lifecycle.drain();
  expect(recordFilesUnder(root)).toEqual([]);
  const markers = () => filesUnder(root).filter((path) => path.endsWith(".outcome"));
  expect(markers()).toHaveLength(3);
  await lifecycle.drain({ now: Date.now() + 25 * 60 * 60 * 1000 });
  expect(markers()).toEqual([]);
});

async function replicaBridge(good: LocalEndpoint, bad: LocalEndpoint) {
  const primary = writerFor(endpoint.url);
  return bridge({
    writer: {
      ...primary,
      replicas: [
        { apiUrl: good.url, apiKey: "synthetic-key-good", projectName: "good" },
        { apiUrl: bad.url, apiKey: "synthetic-key-bad", projectName: "bad" },
      ],
    },
  });
}

const toolEndings = (target: LocalEndpoint) =>
  target.requests.filter(
    ({ method, payload }) => method === "PATCH" && payload["end_time"] === CHILD_END,
  );

it.each(["reject", "down"] as const)(
  "settles the healthy replica's tools while the other replica is %s",
  async (mode) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const good = await localEndpoint();
    const bad = await localEndpoint();
    bad.state.mode = mode;
    const lifecycle = await rootAndChild(
      await replicaBridge(good, bad),
      { base: { repository_name: "acme/project" }, run: { end_time: END } },
      { metadata: { runType: "tool" }, run: { end_time: CHILD_END } },
    );
    for (let pass = 0; pass < 3; pass += 1) await lifecycle.drain();
    expect(toolEndings(good)).toHaveLength(1);
    warn.mockRestore();
    await good.close();
    await bad.close();
  },
);

it("drops a child with its rejected root and names it in one warning", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  endpoint.rejectedIds.add(ROOT_ID);
  const lifecycle = bridge();
  await save(lifecycle, "turn", "root", runPost("root"));
  await save(lifecycle, "turn", "child", runPost("child", { metadata: { runType: "tool" } }));
  for (let pass = 0; pass < 3; pass += 1) await lifecycle.drain();
  const childPosts = endpoint.requests.filter(({ payload }) => payload["id"] === CHILD_ID);
  expect(childPosts.length).toBeLessThanOrEqual(1);
  const named = warn.mock.calls.filter(([message]) => String(message).includes(CHILD_ID));
  expect(named).toHaveLength(1);
  warn.mockRestore();
});

it("keeps a root end time once attribution is resolved", async () => {
  const lifecycle = bridge();
  await save(lifecycle, "turn", "root", runPost("root", { base: OWNER, run: { end_time: END } }));
  await lifecycle.drain();
  expect(endTimes()).toEqual([END]);
});

it("restores muted end times after a restart without attribution", async () => {
  const marker = "private-muted-end-time-marker";
  const muted = { privacyMode: "metadata" as const, base: { private: marker } };
  const first = bridge();
  const evidence = turnEvidence("provisional");
  await save(first, "turn", "root", runPost("root", muted), evidence);
  const child = runPost("child", { ...muted, run: { end_time: END, outputs: { result: marker } } });
  await save(first, "turn", "child", child, evidence, [scope("turn", "root")]);
  const sparse = runPatch("child", { outputs: { result: marker } }, { privacyMode: "metadata" });
  await save(first, "turn", "sparse", sparse, evidence, [scope("turn", "child")]);
  await expect(first.drain()).resolves.toMatchObject({
    delivered: 3,
    settlement: { turns: [{ status: "deferred", reason: "provisional" }] },
  });
  expect(endTimes()).toEqual([undefined, undefined, undefined]);
  expect(metadataOf(2)).toMatchObject({ metadata: { status: "running" } });
  const restarted = bridge();
  const closing = runPatch(
    "root",
    {},
    { privacyMode: "metadata", privacyContext: { status: "running" } },
  );
  await save(restarted, "turn", "closing", closing, turnEvidence(), [scope("turn", "root")]);
  const start = endpoint.requests.length;
  await restarted.drain();
  const final = endpoint.requests.slice(start).find(({ payload }) => payload["end_time"] === END);
  expect(final?.path).toContain(CHILD_ID);
  expect(final?.payload["extra"]).toMatchObject({ metadata: { status: "completed" } });
  expect(JSON.stringify([endpoint.requests, await records()])).not.toContain(marker);
});

it("drains historical captures saved before attribution readiness existed", async () => {
  const lifecycle = bridge();
  const legacy = async (eventId: string, options: Parameters<typeof runPost>[1]) => {
    await save(
      lifecycle,
      "turn",
      eventId,
      runPost("child", { ...options, run: { end_time: END } }),
      turnEvidence("provisional", []),
    );
    const path = eventPath(root, scope("turn", eventId));
    const record = JSON.parse(await readFile(path, "utf8")) as {
      turnEvidence: Record<string, unknown>;
    };
    delete record.turnEvidence["attributionReady"];
    await writeFile(path, JSON.stringify(record));
    return { path, record };
  };
  const full = await legacy("full", { base: OWNER });
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 1 });
  expect(endTimes()).toEqual([END]);
  await legacy("muted", { privacyMode: "metadata", base: { private: "legacy" } });
  await lifecycle.drain();
  expect(endTimes(1)).toEqual([undefined]);
  expect(metadataOf(1)).toMatchObject({ metadata: { status: "running" } });
  full.record.turnEvidence["attributionReady"] = "invalid";
  await writeFile(full.path, JSON.stringify(full.record));
  await expect(lifecycle.drain()).rejects.toThrow("attributionReady must be a boolean");
});

it("keeps stored error status and private root details on settlement patches", async () => {
  const marker = "private-root-repo-marker";
  const rootOptions = {
    privacyMode: "metadata" as const,
    base: { repository_name: "private/project", repository_url: `https://x.invalid/${marker}` },
    run: { end_time: END },
  };
  const child = {
    ...subagent,
    metadata: { agentType: "subagent" as const },
    run: { end_time: END, error: "tool error" },
  };
  const lifecycle = await rootAndChild(bridge(), rootOptions, child);
  await expect(lifecycle.drain()).resolves.toMatchObject({
    delivered: 4,
    settlement: { turns: [{ status: "settled", patches: 2 }] },
  });
  expect(endTimes().slice(0, 2)).toEqual([undefined, undefined]);
  const statuses = [1, 2, 3].map(
    (index) => (metadataOf(index) as { metadata: { status: string } }).metadata.status,
  );
  expect(statuses).toEqual(["error", "completed", "error"]);
  expect(JSON.stringify(await records())).not.toContain(marker);

  const errored = bridge({ sessionId: "session-2" });
  await save(
    errored,
    "turn",
    "root",
    runPost("root", { ...rootOptions, privacyContext: { status: "error" } }),
  );
  await save(
    errored,
    "turn",
    "child",
    runPost("child", { base: REPOSITORY }),
    turnEvidence("open"),
  );
  const start = endpoint.requests.length;
  await expect(errored.drain()).resolves.toMatchObject({ delivered: 3, pending: 0 });
  expect(calls(start)).toEqual(["POST runs", "POST runs", `PATCH ${ROOT_ID}`]);
  expect(endpoint.requests[start + 2]?.payload).toMatchObject({
    end_time: END,
    extra: { metadata: { status: "error" } },
  });
});

it("keeps an explicit empty error after a later sparse status update", async () => {
  const lifecycle = await rootAndChild(
    bridge(),
    { base: OWNER, run: { end_time: END } },
    { privacyMode: "metadata" },
  );
  const error = runPatch("child", { error: "" }, { privacyContext: { status: "error" } });
  await save(lifecycle, "turn", "error", error, turnEvidence(), [scope("turn", "child")]);
  const sparse = runPatch("child", { outputs: { result: "done" } }, { privacyMode: "metadata" });
  await save(lifecycle, "turn", "sparse", sparse, turnEvidence(), [scope("turn", "error")]);
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 5, pending: 0 });
  const patches = endpoint.requests.filter(({ path }) => path.endsWith(CHILD_ID));
  expect(patches.map(({ payload }) => payload["error"])).toEqual(["", undefined, undefined]);
  const statuses = patches.map(
    ({ payload }) => (payload["extra"] as { metadata: { status: string } }).metadata.status,
  );
  expect(statuses.slice(1)).toEqual(["completed", "error"]);
});

it("keeps a child's explicit Git commit across a sparse patch and a conflicting sibling", async () => {
  const lifecycle = bridge();
  const children = turnEvidence("authoritative", [CHILD_ID, SIBLING_ID]);
  const open = turnEvidence("open", [CHILD_ID, SIBLING_ID]);
  await save(lifecycle, "turn", "root", runPost("root"), children);
  await save(
    lifecycle,
    "turn",
    "child",
    runPost("child", { base: { git_commit_sha: "A" } }),
    open,
    [scope("turn", "root")],
  );
  await save(lifecycle, "turn", "sparse", runPatch("child", { outputs: {} }), open, [
    scope("turn", "child"),
  ]);
  const sibling = runPost("sibling", {
    base: { repository_name: "acme/project", git_commit_sha: "B" },
  });
  await save(lifecycle, "turn", "sibling", sibling, open, [scope("turn", "root")]);
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 6, pending: 0 });
  const patches = endpoint.requests.filter(({ path }) => path.endsWith(CHILD_ID));
  expect(patches.at(-1)?.payload["extra"]).toMatchObject({
    metadata: { repository_name: "acme/project", git_commit_sha: "A" },
  });
});

const branch = (name: string) => ({
  base: { repository_name: "acme/project", git_branch: name },
});

it("delivers same-time settlement revisions in dependency order", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T12:00:00.000Z"));
  try {
    const lifecycle = bridge();
    const sources = ["root", "child"];
    const generatedId = (eventIds: string[], name: string) =>
      `turn-settlement-${createHash("sha256")
        .update(
          JSON.stringify({
            turnId: "turn",
            runId: CHILD_ID,
            rootRunId: ROOT_ID,
            childRunIds: [CHILD_ID],
            dependencies: eventIds
              .map((eventId) => scope("turn", eventId))
              .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
            attribution: branch(name).base,
          }),
        )
        .digest("hex")}`;
    endpoint.failingPaths.add(`/api/v1/runs/${CHILD_ID}`);
    await rootAndChild(
      lifecycle,
      { ...branch("main"), run: { end_time: END } },
      { metadata: { agentType: "subagent" }, run: { end_time: END } },
    );
    let previous = generatedId(sources, "main");
    let dependency = scope("turn", "root");
    await expect(lifecycle.drain()).resolves.toMatchObject({ failed: 2 });
    for (const name of ["branch-b", "branch-c"]) {
      const eventId = Array.from({ length: 10_000 }, (_, index) => `${name}-${index}`).find(
        (candidate) => generatedId([...sources, candidate], name) < previous,
      )!;
      await save(lifecycle, "turn", eventId, runPatch("root", {}, branch(name)), turnEvidence(), [
        dependency,
      ]);
      sources.push(eventId);
      previous = generatedId(sources, name);
      dependency = scope("turn", eventId);
      await lifecycle.drain();
    }
    endpoint.failingPaths.clear();
    const start = endpoint.requests.length;
    await expect(lifecycle.drain()).resolves.toMatchObject({ pending: 0 });
    const branches = endpoint.requests
      .slice(start)
      .filter(({ path }) => path.endsWith(CHILD_ID))
      .map(
        ({ payload }) =>
          (payload["extra"] as { metadata: { git_branch: string } }).metadata.git_branch,
      );
    expect(branches).toEqual(["main", "branch-b", "branch-c"]);
  } finally {
    clock.mockRestore();
  }
});

it("removes every file of a settled turn, large content included", async () => {
  const lifecycle = bridge();
  const large = {
    inputs: { prompt: "p".repeat(128_000) },
    outputs: { answer: "o".repeat(128_000) },
  };
  await save(lifecycle, "parent", "root", runPost("root", { run: { ...large, end_time: END } }));
  await save(
    lifecycle,
    "child-turn",
    "child",
    runPost("child", {
      metadata: { runType: "subagent" },
      base: { repository_name: "acme/project" },
      run: { end_time: CHILD_END },
    }),
    turnEvidence("authoritative", [], CHILD_ID),
    [scope("parent", "root")],
  );
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 3, pending: 0 });
  expectNoFilesLeft(root);
});

it("keeps a turn that is not settled yet and removes it after the next drain settles it", async () => {
  const lifecycle = bridge();
  await save(lifecycle, "turn", "root", runPost("root"), turnEvidence("open", [], ROOT_ID));
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 1, pending: 0 });
  expect(filesUnder(root)).toHaveLength(1);
  await save(
    lifecycle,
    "turn",
    "closing",
    runPatch("root", { end_time: END }),
    turnEvidence("authoritative", [], ROOT_ID),
    [scope("turn", "root")],
  );
  await lifecycle.drain();
  expectNoFilesLeft(root);
});

const GRACE_MS = 60 * 60 * 1000;

async function childWhoseParentWasRemoved() {
  const lifecycle = bridge();
  await save(
    lifecycle,
    "parent",
    "root",
    runPost("root", { run: { end_time: END } }),
    turnEvidence("authoritative", [], ROOT_ID),
  );
  await expect(lifecycle.drain()).resolves.toMatchObject({ delivered: 2, pending: 0 });
  expectNoFilesLeft(root);
  await save(
    lifecycle,
    "child-turn",
    "child",
    runPost("child", {
      metadata: { runType: "subagent" },
      base: { repository_name: "acme/project" },
      run: { end_time: CHILD_END },
    }),
    turnEvidence("authoritative", [], CHILD_ID),
  );
  return lifecycle;
}

it("removes a child turn whose parent was removed in an earlier drain once the grace passes", async () => {
  const lifecycle = await childWhoseParentWasRemoved();
  await lifecycle.drain();
  expect(recordFilesUnder(root)).toHaveLength(1);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + GRACE_MS + 1000);
  try {
    await lifecycle.drain();
    expectNoFilesLeft(root);
  } finally {
    clock.mockRestore();
  }
});

it("keeps an old child turn while its parent is still on disk", async () => {
  const lifecycle = bridge();
  await save(
    lifecycle,
    "parent",
    "root",
    runPost("root"),
    turnEvidence("open", [CHILD_ID], ROOT_ID),
  );
  await save(
    lifecycle,
    "child-turn",
    "child",
    runPost("child", {
      metadata: { runType: "subagent" },
      base: { repository_name: "acme/project" },
      run: { end_time: CHILD_END },
    }),
    turnEvidence("authoritative", [], CHILD_ID),
  );
  await lifecycle.drain();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + GRACE_MS + 1000);
  try {
    await lifecycle.drain();
    expect((await records()).map(({ record }) => record.turnId)).toContain("child-turn");
  } finally {
    clock.mockRestore();
  }
});

const values = (text: string) => ({
  run: { inputs: { prompt: text }, outputs: { answer: text } },
});

it("keeps open, pending and other-account payloads intact", async () => {
  const lifecycle = bridge();
  await save(
    lifecycle,
    "open",
    "open",
    runPost("sibling", values("open")),
    turnEvidence("open", [], SIBLING_ID),
  );
  await save(
    lifecycle,
    "pending",
    "pending",
    runPost("root", values("pending")),
    turnEvidence("authoritative", [], ROOT_ID),
  );
  const foreign = bridge({ writer: writerFor(endpoint.url, "synthetic-foreign-key") });
  await save(
    foreign,
    "foreign",
    "foreign",
    runPost("sibling", values("foreign")),
    turnEvidence("authoritative", [], SIBLING_ID),
  );
  const [destination] = createLangSmithUploadWriter(writerFor(endpoint.url)).destinations;
  const delivered = {
    ...scope("foreign", "foreign"),
    destination: destination!.id,
    outcome: "delivered" as const,
  };
  await createCaptureStore(root).recordOutcome(delivered);
  endpoint.failing.add(0);
  await expect(lifecycle.drain()).resolves.toMatchObject({
    delivered: 0,
    failed: 2,
    pending: 2,
    accountMismatch: 0,
  });
  for (const text of ["open", "pending", "foreign"])
    await expect(createCaptureStore(root).read(scope(text, text))).resolves.toMatchObject({
      version: 2,
      normalizedPayload: { run: { inputs: { prompt: text } } },
    });
});
