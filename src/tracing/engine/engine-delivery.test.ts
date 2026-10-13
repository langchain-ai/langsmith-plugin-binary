import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { LocalRequest } from "../../test-support/models/lifecycle.js";
import type { LangSmithUploadWriterOptions, PreparedRunPostSubmission } from "../upload/models.js";
import { createTracingEngine } from "./engine.js";

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
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        payload: body === "" ? {} : JSON.parse(body),
      });
      response.writeHead(state.status, { "content-type": "application/json" });
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
  return { requests, state, apiUrl: `http://127.0.0.1:${address.port}/api/v1` };
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
    session.captureSnapshot({
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

it("spends one delivery attempt per drain and reports dropped work", async () => {
  const root = area();
  const endpoint = await localEndpoint();
  endpoint.state.status = 400;
  const session = openSession(root, writerFor(endpoint.apiUrl, "delivery-project"), "retry");
  await captureRoot(session, "turn-retry", "33333333-3333-4333-8333-333333333333");

  const results: string[] = [];
  const posts: number[] = [];
  for (let drain = 0; drain < 5; drain += 1) {
    const before = endpoint.requests.length;
    results.push(await session.drain());
    posts.push(endpoint.requests.length - before);
  }
  endpoint.state.status = 200;
  const before = endpoint.requests.length;
  await session.drain();

  expect(results).toEqual(["deferred", "deferred", "deferred", "deferred", "dropped"]);
  expect(posts).toEqual([1, 1, 1, 1, 1]);
  expect(endpoint.requests.length - before).toBe(0);
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
    await expect(
      after.capture({
        turnId: "turn-switch",
        eventId: "event-turn-switch",
        submission: rootSubmission(runId),
        turnEvidence: { rootRunId: runId, childRunIds: [], closureState: "authoritative" },
      }),
    ).rejects.toThrow("no worker in this test");
    await after.drain();

    const posts = endpoint.requests.filter(({ method }) => method === "POST");
    expect(posts.map(({ payload }) => payload["id"])).toEqual([runId]);
    const projects = endpoint.requests.map(({ payload }) => payload["session_name"]);
    expect(new Set(projects)).toEqual(new Set(["project-a"]));
  }
});
