import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { expectNoPathsLeft } from "../../test-support/tracing/delivery.js";
import { runUnits } from "../../test-support/tracing/ingest.js";
import type { LocalRequest } from "../../test-support/models/lifecycle.js";
import type { LangSmithUploadWriterOptions, PreparedRunPostSubmission } from "../upload/models.js";
import { createTracingEngine } from "./engine.js";

const { delays } = vi.hoisted(() => ({ delays: [] as number[] }));

vi.mock("../delivery/constants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../delivery/constants.js")>()),
  DELIVERY_QUICK_RETRY_MS: 0,
}));

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setTimeout: (ms?: number) => {
      delays.push(ms ?? 0);
      return actual.setTimeout((ms ?? 0) >= 1_000 ? 0 : ms);
    },
  };
});

const integration = "claude-code";
const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) removeTree(root);
});

function removeTree(root: string): void {
  const { files, directories } = listPaths(root);
  for (const file of files) unlinkSync(file);
  for (const directory of directories.toSorted((left, right) => right.length - left.length))
    rmdirSync(directory);
  rmdirSync(root);
}

function listPaths(root: string): { files: string[]; directories: string[] } {
  const files: string[] = [];
  const found: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        found.push(path);
      } else files.push(path);
    }
  }
  return { files, directories: found };
}

async function localEndpoint() {
  const requests: LocalRequest[] = [];
  const state = { status: 200 };
  const flags = { failFirst: false };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      for (const unit of runUnits(
        request.method ?? "",
        request.url ?? "",
        body === "" ? {} : JSON.parse(body),
      ))
        requests.push({ method: unit.method, path: unit.path, payload: unit.payload });
      const refuse = flags.failFirst && requests.length === 1;
      response.writeHead(refuse ? 503 : state.status, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local endpoint did not start");
  closers.push(
    () =>
      new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      ),
  );
  return { requests, state, flags, apiUrl: `http://127.0.0.1:${address.port}/api/v1` };
}

function writerFor(apiUrl: string, projectName: string): LangSmithUploadWriterOptions {
  return {
    destinations: [{ apiKey: "synthetic-delivery-key", apiUrl, projectName }],
    redact: false,
  };
}

function openSession(
  root: string,
  writer: LangSmithUploadWriterOptions,
  sessionId: string,
  runId?: string,
) {
  return createTracingEngine({ storageRoot: root, integration, writer }).forSession({
    sessionId,
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      throw new Error("no worker in this test");
    },
    reconstruct: async () =>
      runId === undefined
        ? { status: "deferred", reason: "missing-thread-identity" }
        : {
            status: "ready",
            outputs: [
              {
                eventId: `rebuilt-${runId}`,
                submission: rootSubmission(runId),
                turnEvidence: { rootRunId: runId, childRunIds: [], closureState: "authoritative" },
              },
            ],
          },
  });
}

function rootSubmission(runId: string): PreparedRunPostSubmission {
  const order = `20261010T120000000000Z${runId}`;
  return {
    operation: "post",
    integration,
    privacyMode: "full",
    metadata: { integration, threadId: "thread-delivery", agentType: "root", runType: "root" },
    run: {
      id: runId,
      name: "root run",
      run_type: "chain",
      start_time: "2026-10-10T12:00:00.000Z",
      end_time: "2026-10-10T12:00:01.000Z",
      trace_id: runId,
      dotted_order: order,
      inputs: {},
    },
  };
}

async function captureRoot(
  session: ReturnType<typeof openSession>,
  turnId: string,
  runId: string,
): Promise<void> {
  await expect(
    session.capture({
      turnId,
      eventId: `event-${turnId}`,
      submission: rootSubmission(runId),
      turnEvidence: { rootRunId: runId, childRunIds: [], closureState: "authoritative" },
    }),
  ).rejects.toThrow("no worker in this test");
}

function area(): string {
  const root = mkdtempSync(join(tmpdir(), "plugins-base-engine-delivery-"));
  roots.push(root);
  return root;
}

it("waits longer between attempts at work that keeps failing", async () => {
  const root = area();
  const endpoint = await localEndpoint();
  endpoint.state.status = 503;
  const session = openSession(root, writerFor(endpoint.apiUrl, "delivery-project"), "retry");
  await captureRoot(session, "turn-retry", "33333333-3333-4333-8333-333333333333");
  const clock = vi.spyOn(Date, "now");
  const start = Date.now();
  const posts: number[] = [];
  const results: string[] = [];
  for (const offset of [0, 1_000, 2_000, 6_000, 8_000, 40_000]) {
    clock.mockReturnValue(start + offset);
    const before = endpoint.requests.length;
    await session.wake().catch(() => undefined);
    results.push(await session.drain());
    posts.push(endpoint.requests.length - before);
  }
  endpoint.state.status = 200;
  clock.mockReturnValue(start + 3_600_000);
  await session.wake().catch(() => undefined);
  results.push(await session.drain());
  clock.mockRestore();
  expect(posts).toEqual([1, 0, 0, 1, 0, 1]);
  expect(results).toEqual([...Array.from({ length: 6 }, () => "deferred"), "completed"]);
}, 20_000);

it("retries a failed upload in the same worker run once its delay has passed", async () => {
  const root = area();
  const endpoint = await localEndpoint();
  endpoint.flags.failFirst = true;
  const session = openSession(root, writerFor(endpoint.apiUrl, "delivery-project"), "retry-now");
  await captureRoot(session, "turn-retry-now", "66666666-6666-4666-8666-666666666666");
  const realNow = Date.now.bind(Date);
  let ticks = 0;
  const clock = vi
    .spyOn(Date, "now")
    .mockImplementation(() => realNow() + (endpoint.requests.length > 0 ? 10_000 * ++ticks : 0));
  try {
    await session.wake().catch(() => undefined);
    await expect(session.drain()).resolves.toBe("completed");
  } finally {
    clock.mockRestore();
  }
  expect(delays.some((ms) => ms >= 1_000)).toBe(true);
  expect(endpoint.requests.map(({ method }) => method)).toEqual(["POST", "POST", "PATCH"]);
  expectNoPathsLeft(root);
});

it("drops work the service rejects for good", async () => {
  const root = area();
  const endpoint = await localEndpoint();
  endpoint.state.status = 400;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const session = openSession(root, writerFor(endpoint.apiUrl, "delivery-project"), "reject");
  await captureRoot(session, "turn-reject", "55555555-5555-4555-8555-555555555555");
  await expect(session.drain()).resolves.toBe("dropped");
  await session.wake().catch(() => undefined);
  await session.drain();
  expect(endpoint.requests).toHaveLength(1);
  expect(String(warn.mock.calls[0]?.join(" "))).toContain("rejected");
  expect(listPaths(root).files).toEqual([expect.stringMatching(/\.outcome$/)]);
  warn.mockRestore();
});

it("delivers leftover work to its captured project after the project changes", async () => {
  for (const replicas of [undefined, [{ projectName: "project-a" }]]) {
    const root = area();
    const endpoint = await localEndpoint();
    const writer = (projectName: string) => ({
      ...writerFor(endpoint.apiUrl, projectName),
      ...(replicas === undefined ? {} : { replicas }),
    });
    const runId = "44444444-4444-4444-8444-444444444444";
    const before = openSession(root, writer("project-a"), "switch");
    await captureRoot(before, "turn-switch", runId);

    const after = openSession(root, writer("project-b"), "switch");
    await expect(after.drain()).resolves.toBe("completed");
    const posts = endpoint.requests.filter(({ method }) => method === "POST");
    expect(posts.map(({ payload }) => payload["id"])).toEqual([runId]);
    const projects = endpoint.requests.map(({ payload }) => payload["session_name"]);
    expect(new Set(projects)).toEqual(new Set(["project-a"]));
  }
});
