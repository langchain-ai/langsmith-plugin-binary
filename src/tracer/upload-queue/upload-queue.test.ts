import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeLangSmith } from "../../test-support/models/tracer-queue.js";
import { startFakeLangSmith } from "../../test-support/tracing/fake-langsmith.js";
import { waitFor } from "../../test-support/wait.js";
import type { LangSmithUploadWriterOptions } from "../../tracing/upload/models.js";
import type { RunPatch, RunPost, TracingMode, UploadQueue } from "../models.js";
import { MAX_QUEUED_BYTES, MAX_QUEUED_RUNS } from "./upload-queue-constants.js";
import { createUploadQueue } from "./upload-queue.js";

const SECRET = "synthetic-private-marker";
const FAST_RETRY = { retryBaseMs: 1, retryMaxMs: 10 };
const storageRoot = mkdtempSync(join(tmpdir(), "tracer-queue-"));

let server: FakeLangSmith;
let logs: string[];
let queue: UploadQueue;

function writer(projectName = "tracer-queue"): LangSmithUploadWriterOptions {
  return {
    destinations: [{ apiKey: "synthetic-key", apiUrl: server.endpoint, projectName }],
    redact: false,
    storageRoot,
  };
}

function run(parent?: RunPost, tracingMode: TracingMode = "full"): RunPost {
  const id = randomUUID();
  const order = `20261113T120000000000Z${id}`;
  return {
    id,
    name: parent === undefined ? "turn" : "tool",
    run_type: parent === undefined ? "chain" : "tool",
    trace_id: parent?.trace_id ?? id,
    dotted_order: parent === undefined ? order : `${parent.dotted_order}.${order}`,
    ...(parent === undefined ? {} : { parent_run_id: parent.id }),
    start_time: "2026-11-13T12:00:00.000Z",
    inputs: { prompt: SECRET },
    metadata: {
      integration: "claude-code",
      threadId: "thread-1",
      agentType: "root",
      runType: "root",
    },
    tracingMode,
  };
}

function finish(posted: RunPost): RunPatch {
  const { id, name, run_type, trace_id, dotted_order, metadata, tracingMode } = posted;
  return {
    id,
    name,
    run_type,
    trace_id,
    dotted_order,
    metadata,
    tracingMode,
    end_time: "2026-11-13T12:00:01.000Z",
    outputs: { answer: SECRET },
  };
}

function batchWith(id: string, kind: "posts" | "patches"): number {
  return server.batches.findIndex((batch) => batch[kind].some((item) => item["id"] === id));
}

async function uploaded(): Promise<void> {
  await waitFor(() => queue.idle(), "the queue to empty");
}

beforeEach(async () => {
  server = await startFakeLangSmith();
  logs = [];
  queue = createUploadQueue((line) => logs.push(line), FAST_RETRY);
});

afterEach(async () => {
  server.release();
  await server.close();
});

describe("upload queue", () => {
  it("posts a parent before a child that was queued first", async () => {
    const parent = run();
    const child = run(parent);
    queue.post("s1", writer(), child);
    queue.post("s1", writer(), parent);
    queue.flush();
    await uploaded();

    expect(batchWith(parent.id, "posts")).toBe(0);
    expect(batchWith(child.id, "posts")).toBe(1);
  });

  it("holds a patch that arrives while its post is in flight", async () => {
    const root = run();
    server.holdResponses = true;
    queue.post("s1", writer(), root);
    queue.flush();
    await waitFor(() => server.batches.length === 1, "the post to reach the server");
    queue.patch("s1", writer(), finish(root));
    queue.flush();
    expect(queue.pendingFor("s1")).toBe(1);
    expect(queue.pendingFor("s2")).toBe(0);
    await delay(100);
    expect(server.batches).toHaveLength(1);
    server.release();
    await uploaded();

    expect(queue.pendingFor("s1")).toBe(0);
    expect(server.batches[0]!.posts[0]!["end_time"]).toBeUndefined();
    expect(server.batches[1]!.patches[0]).toMatchObject({
      id: root.id,
      outputs: { answer: SECRET },
    });
  });

  it("merges a patch into a post that has not been sent yet", async () => {
    const root = run();
    queue.post("s1", writer(), root);
    queue.patch("s1", writer(), finish(root));
    queue.flush();
    await uploaded();

    expect(server.batches).toHaveLength(1);
    expect(server.batches[0]!.patches).toEqual([]);
    expect(server.batches[0]!.posts[0]).toMatchObject({ outputs: { answer: SECRET } });
  });

  it("does not wait for a parent posted before a restart", async () => {
    const parent = run();
    const child = run(parent);
    queue.post("s1", writer(), child);
    queue.flush();
    await uploaded();
    queue.patch("s1", writer(), finish(parent));
    queue.flush();
    await uploaded();

    expect(batchWith(child.id, "posts")).toBe(0);
    expect(batchWith(parent.id, "patches")).toBe(1);
  });

  it("loses nothing when the server fails five times then succeeds", async () => {
    server.failuresLeft = 5;
    const parent = run();
    const child = run(parent);
    queue.post("s1", writer(), parent);
    queue.post("s1", writer(), child);
    queue.flush();
    await waitFor(() => server.failuresLeft < 3, "two failures");
    queue.patch("s1", writer(), finish(child));
    queue.flush();
    await uploaded();

    expect(server.stored.get(parent.id)).toMatchObject({ name: "turn" });
    expect(server.stored.get(child.id)).toMatchObject({
      name: "tool",
      outputs: { answer: SECRET },
    });
    expect(logs.filter((line) => line.includes("retrying"))).toHaveLength(5);
  });

  it("drops only the run LangSmith rejects for good", async () => {
    server.rejectMarker = "rejected-run";
    const accepted = run();
    const rejected = { ...run(), name: "rejected-run" };
    queue.post("s1", writer(), accepted);
    queue.post("s1", writer(), rejected);
    queue.flush();
    await uploaded();

    expect([...server.stored.keys()]).toEqual([accepted.id]);
    expect(logs.filter((line) => line.startsWith("DROPPED"))).toEqual([
      expect.stringContaining(rejected.id),
    ]);
  });

  it("never sends inputs or outputs in metadata mode", async () => {
    const root = run(undefined, "metadata");
    queue.post("s1", writer(), root);
    queue.flush();
    await uploaded();
    queue.patch("s1", writer(), finish(root));
    queue.flush();
    await uploaded();

    expect(server.batches.map(({ patches }) => patches.length)).toEqual([0, 1]);
    expect(server.batches.map(({ body }) => body.includes(SECRET))).toEqual([false, false]);
  });

  it("uploads nothing for a run whose tracing is off", async () => {
    const traced = run();
    const untraced = run(undefined, "off");
    queue.post("s1", writer(), untraced);
    queue.patch("s1", writer(), finish(untraced));
    queue.post("s1", writer(), traced);
    queue.flush();
    await uploaded();

    expect([...server.stored.keys()]).toEqual([traced.id]);
  });

  it("sends at most 100 runs per request and 4 requests at once", async () => {
    server.holdResponses = true;
    for (const project of ["a", "b", "c", "d", "e"]) {
      for (let count = 0; count < 101; count += 1) queue.post("s1", writer(project), run());
    }
    queue.flush();
    await waitFor(() => server.batches.length === 4, "four requests");
    server.release();
    await uploaded();

    expect(server.mostInFlight).toBe(4);
    expect(server.batches.map(({ posts }) => posts.length).toSorted((a, b) => a - b)).toEqual([
      1, 1, 1, 1, 1, 100, 100, 100, 100, 100,
    ]);
  });

  it("is full at the run limit and empties once uploads drain", async () => {
    for (let count = 1; count < MAX_QUEUED_RUNS; count += 1) queue.post("s1", writer(), run());
    expect(queue.full()).toBe(false);
    queue.post("s1", writer(), run());
    expect(queue.full()).toBe(true);
    queue.flush();
    await uploaded();

    expect(queue.full()).toBe(false);
  });

  it("is full at the byte limit and releases every byte once confirmed", async () => {
    const big = run();
    queue.post("s1", writer(), big);
    queue.patch("s1", writer(), {
      ...finish(big),
      outputs: { answer: "x".repeat(MAX_QUEUED_BYTES) },
    });
    expect(queue.full()).toBe(true);
    queue.flush();
    await uploaded();
    expect(queue.full()).toBe(false);

    queue.post("s1", writer(), {
      ...run(),
      inputs: { prompt: "x".repeat(MAX_QUEUED_BYTES - 4096) },
    });
    expect(queue.full()).toBe(false);
    queue.post("s1", writer(), { ...run(), inputs: { prompt: "x".repeat(8192) } });
    expect(queue.full()).toBe(true);
  });
});
