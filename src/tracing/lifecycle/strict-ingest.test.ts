import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { afterQuiet } from "../../test-support/clock.js";
import type { LocalEndpoint } from "../../test-support/models/lifecycle.js";
import {
  expectNoFilesLeft,
  filesUnder,
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
} from "../../test-support/tracing/lifecycle.js";

const END = "2026-10-10T12:00:01.000Z";
const LATER = "2026-10-10T12:30:00.000Z";
const EXPIRED_MS = 7 * 60 * 60 * 1000;
const subagent = { metadata: { runType: "subagent" as const } };
let endpoint: LocalEndpoint;
let root: string;

beforeEach(async () => {
  endpoint = await localEndpoint();
  endpoint.state.mode = "strict";
  root = temporaryRoot();
});

afterEach(() => endpoint.close());

const bridge = () => testBridge(root, endpoint.url);
const scope = (turnId: string, eventId: string) => captureScope("session-1", turnId, eventId);
const updatesOf = (runId: string) =>
  endpoint.requests.filter(({ method, payload }) => method === "PATCH" && payload["id"] === runId);

it("sends a tool update held for attribution once, with its end time and outputs", async () => {
  const lifecycle = bridge();
  await save(lifecycle, "turn", "root", runPost("root"), turnEvidence("open", [CHILD_ID]));
  await save(lifecycle, "turn", "child", runPost("child"), turnEvidence("open"), [
    scope("turn", "root"),
  ]);
  await save(
    lifecycle,
    "turn",
    "child-end",
    runPatch("child", { outputs: { done: true }, end_time: END }),
    turnEvidence("open"),
    [scope("turn", "child")],
  );
  await save(lifecycle, "turn", "end", runPatch("root", { end_time: END }), turnEvidence(), [
    scope("turn", "root"),
  ]);
  await lifecycle.drain();
  expect(endpoint.schemaRejections).toBe(0);
  expect(
    updatesOf(CHILD_ID).map(({ payload }) => [payload["end_time"], payload["outputs"]]),
  ).toEqual([[END, { done: true }]]);
});

it("closes an attribution update with the run's own end time", async () => {
  const lifecycle = bridge();
  await save(
    lifecycle,
    "turn",
    "root",
    runPost("root", { base: REPOSITORY, run: { end_time: END } }),
  );
  await save(
    lifecycle,
    "turn",
    "child",
    runPost("child", { ...subagent, run: { end_time: END } }),
    turnEvidence(),
    [scope("turn", "root")],
  );
  await lifecycle.drain();
  expect(endpoint.schemaRejections).toBe(0);
  expect(updatesOf(CHILD_ID).map(({ payload }) => payload["end_time"])).toEqual([END]);
});

it("closes an attribution update for a run that never recorded an end time", async () => {
  const lifecycle = bridge();
  await save(
    lifecycle,
    "turn",
    "root",
    runPost("root", { base: REPOSITORY, run: { end_time: END } }),
  );
  await save(lifecycle, "turn", "child", runPost("child", subagent), turnEvidence(), [
    scope("turn", "root"),
  ]);
  await afterQuiet(() => lifecycle.drain());
  expect(endpoint.schemaRejections).toBe(0);
  expect(updatesOf(CHILD_ID)).toHaveLength(1);
});

it("leaves a still-running child for its real end once its turn has stopped", async () => {
  const lifecycle = bridge();
  await save(
    lifecycle,
    "turn",
    "root",
    runPost("root", { base: REPOSITORY }),
    turnEvidence("open", [CHILD_ID]),
  );
  await save(lifecycle, "turn", "child", runPost("child"), turnEvidence("open"), [
    scope("turn", "root"),
  ]);
  await save(
    lifecycle,
    "turn",
    "end",
    runPatch("root", { end_time: END }, { base: REPOSITORY }),
    turnEvidence(),
    [scope("turn", "root")],
  );
  await lifecycle.drain();
  const finished = runPatch("child", { outputs: { real: true }, end_time: LATER });
  await save(lifecycle, "turn", "child-end", finished, turnEvidence(), [scope("turn", "child")]);
  await lifecycle.drain();
  expect(endpoint.schemaRejections).toBe(0);
  expect(
    updatesOf(CHILD_ID).map(({ payload }) => [payload["end_time"], payload["outputs"]]),
  ).toEqual([[LATER, { real: true }]]);
  expect(updatesOf(CHILD_ID)[0]?.payload["extra"]).toMatchObject({
    metadata: { ls_git_repo: REPOSITORY.ls_git_repo },
  });
});

it("sends every held update for a run together", async () => {
  const lifecycle = bridge();
  await save(lifecycle, "turn", "root", runPost("root"), turnEvidence("open", [CHILD_ID]));
  await save(lifecycle, "turn", "child", runPost("child"), turnEvidence("open"), [
    scope("turn", "root"),
  ]);
  await save(
    lifecycle,
    "turn",
    "child-end",
    runPatch("child", { outputs: { done: true }, end_time: END }),
    turnEvidence("open"),
    [scope("turn", "child")],
  );
  await save(
    lifecycle,
    "turn",
    "child-error",
    runPatch("child", { error: "boom" }),
    turnEvidence("open"),
    [scope("turn", "child-end")],
  );
  await save(lifecycle, "turn", "end", runPatch("root", { end_time: END }), turnEvidence(), [
    scope("turn", "root"),
  ]);
  await lifecycle.drain();
  expect(updatesOf(CHILD_ID).map(({ payload }) => [payload["outputs"], payload["error"]])).toEqual([
    [{ done: true }, "boom"],
  ]);
});

it("warns when a held update expires before its turn could finish", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const lifecycle = bridge();
  await save(lifecycle, "turn", "root", runPost("root"), turnEvidence("open", [CHILD_ID]));
  await save(lifecycle, "turn", "child", runPost("child"), turnEvidence("open"), [
    scope("turn", "root"),
  ]);
  await save(
    lifecycle,
    "turn",
    "child-end",
    runPatch("child", { outputs: { done: true }, end_time: END }),
    turnEvidence("open"),
    [scope("turn", "child")],
  );
  await lifecycle.drain();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + EXPIRED_MS);
  await lifecycle.drain();
  clock.mockRestore();
  expect(
    warn.mock.calls.filter(([message]) => String(message).includes("still waiting")),
  ).toHaveLength(1);
  warn.mockRestore();
});

it("doesn't warn that a quiet child turn never ended", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const lifecycle = bridge();
  await save(
    lifecycle,
    "child-turn",
    "child",
    runPost("child", { run: { end_time: END } }),
    turnEvidence("open", [], CHILD_ID),
  );
  await afterQuiet(() => lifecycle.drain());
  expect(warn.mock.calls.filter(([message]) => String(message).includes("never ended"))).toEqual(
    [],
  );
  warn.mockRestore();
});

it("removes nested child turns in the same pass as the turn they belong to", async () => {
  const lifecycle = bridge();
  await save(
    lifecycle,
    "turn",
    "root",
    runPost("root", { run: { end_time: END } }),
    turnEvidence("authoritative", [], ROOT_ID),
  );
  await save(
    lifecycle,
    "child-turn",
    "child",
    runPost("child", { run: { end_time: END } }),
    turnEvidence("authoritative", [], CHILD_ID),
  );
  await save(
    lifecycle,
    "grandchild-turn",
    "sibling",
    runPost("sibling", { run: { end_time: END, parent_run_id: CHILD_ID } }),
    turnEvidence("authoritative", [], SIBLING_ID),
  );
  await lifecycle.drain();
  expectNoFilesLeft(root);
});

it("doesn't warn about a held update that settlement already sent when it expires", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const lifecycle = bridge();
  await save(lifecycle, "turn", "root", runPost("root"), turnEvidence("open", []));
  await save(
    lifecycle,
    "child-turn",
    "child",
    runPost("child"),
    turnEvidence("open", [], CHILD_ID),
  );
  await save(
    lifecycle,
    "child-turn",
    "child-end",
    runPatch("child", { outputs: { done: true }, end_time: END }),
    turnEvidence("authoritative", [], CHILD_ID),
    [scope("child-turn", "child")],
  );
  await lifecycle.drain();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + EXPIRED_MS);
  await lifecycle.drain();
  clock.mockRestore();
  expect(updatesOf(CHILD_ID)).toHaveLength(1);
  expect(warn.mock.calls.filter(([message]) => String(message).includes("still waiting"))).toEqual(
    [],
  );
  warn.mockRestore();
});

it("still sends a late real end after its turn receipt is gone", async () => {
  const lifecycle = bridge();
  await save(
    lifecycle,
    "turn",
    "root",
    runPost("root", { base: REPOSITORY }),
    turnEvidence("open", [CHILD_ID]),
  );
  await save(lifecycle, "turn", "child", runPost("child"), turnEvidence("open"), [
    scope("turn", "root"),
  ]);
  await save(
    lifecycle,
    "turn",
    "end",
    runPatch("root", { end_time: END }, { base: REPOSITORY }),
    turnEvidence(),
    [scope("turn", "root")],
  );
  await lifecycle.drain();
  for (const path of filesUnder(root).filter((file) => file.endsWith(".outcome"))) unlinkSync(path);
  const finished = runPatch("child", { outputs: { real: true }, end_time: LATER });
  await save(lifecycle, "turn", "child-end", finished, turnEvidence());
  await lifecycle.drain();
  expect(endpoint.schemaRejections).toBe(0);
  expect(
    updatesOf(CHILD_ID).map(({ payload }) => [payload["end_time"], payload["outputs"]]),
  ).toEqual([[LATER, { real: true }]]);
});
