import { createServer, type Server } from "node:http";
import { Client } from "langsmith";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ROOT_ID } from "../../test-support/constants.js";
import { createLangSmithUploadWriter } from "./index.js";

const limits = vi.hoisted(() => ({ deadlineMs: 300 }));

vi.mock("./constants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./constants.js")>();
  return Object.defineProperties(
    { ...actual, UPLOAD_REQUEST_TIMEOUT_MS: 200 },
    { UPLOAD_SEND_DEADLINE_MS: { enumerable: true, get: () => limits.deadlineMs } },
  );
});

let server: Server;
let url: string;

beforeEach(async () => {
  server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not start");
  url = `http://127.0.0.1:${address.port}/api/v1`;
});

afterEach(() => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  server.close();
});

const post = () =>
  ({
    operation: "post",
    integration: "claude-code",
    privacyMode: "full",
    metadata: { integration: "claude-code", threadId: "t", agentType: "root", runType: "root" },
    run: {
      id: ROOT_ID,
      name: "run",
      run_type: "chain",
      start_time: "2026-10-10T12:00:00.000Z",
      inputs: {},
    },
  }) as const;

async function sendFailure(): Promise<unknown> {
  const writer = createLangSmithUploadWriter({
    redact: false,
    destinations: [{ apiKey: "synthetic-key", apiUrl: url, projectName: "p" }],
  });
  return writer.send(post(), writer.destinations[0]!.id).catch((error: unknown) => error);
}

it("gives up on a request the service never answers even when the deadline is far away", async () => {
  limits.deadlineMs = 60_000;
  const failure = await sendFailure();
  expect((failure as Error).message).toBe("LangSmith upload failed");
}, 4_000);

it("also gives up when the SDK never settles, such as a stuck serialization", async () => {
  limits.deadlineMs = 300;
  vi.spyOn(Client.prototype, "batchIngestRuns").mockReturnValue(new Promise(() => undefined));
  const failure = await sendFailure();
  expect((failure as Error).message).toBe("LangSmith upload failed");
});
