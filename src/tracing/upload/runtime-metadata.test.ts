import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __version__ } from "langsmith";
import { RUN_ID } from "../../test-support/constants.js";
import type { LocalRequest } from "../../test-support/models/upload.js";
import { childEnvironment, moduleUrl, temporaryRoot } from "../../test-support/tracing/delivery.js";
import { runUnits } from "../../test-support/tracing/ingest.js";
import { createLangSmithUploadWriter } from "./index.js";
import type {
  LangSmithUploadWriterOptions,
  PreparedRunPatchSubmission,
  PreparedRunPostSubmission,
} from "./models.js";

const SECRET_NAME_VALUES = {
  LANGSMITH_SECRET_THING: "env-secret-value",
  LANGSMITH_USER_EMAIL: "someone@example.com",
  LANGCHAIN_SERVICE_TOKEN: "env-token-value",
  LANGSMITH_Db_Password: "env-password-value",
  LANGSMITH_API_KEY: "env-api-key-value",
  OPENAI_API_KEY: "unrelated-api-key-value",
  LANGSMITH_RUNS_ENDPOINTS:
    '[{"api_url":"http://env-endpoint.invalid","api_key":"env-endpoints-key"}]',
  LANGSMITH_PROXY: "http://proxy-user:env-proxy-password@proxy.invalid:8080",
  LANGSMITH_CUSTOM_ENDPOINT_X: "http://env-custom-endpoint.invalid",
  LANGCHAIN_CALLBACK_URL: "http://env-callback-user:env-callback-pass@callback.invalid",
  LANGSMITH_AUTH_MODE: "env-auth-mode",
  LANGCHAIN_EXTRA_HEADERS: "env-extra-headers",
} as const;
const SECRET_LOOKING_VALUE = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
let server: Server;
let endpoint: string;
let requests: LocalRequest[];

beforeEach(async () => {
  requests = [];
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const payload = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
      for (const unit of runUnits(request.method ?? "", request.url ?? "", payload))
        requests.push({
          method: unit.method,
          path: unit.path,
          apiKey: String(request.headers["x-api-key"] ?? ""),
          workspaceId: undefined,
          payload: unit.payload,
        });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local server did not start");
  endpoint = `http://127.0.0.1:${address.port}/api/v1`;
  vi.stubEnv("LANGSMITH_FOO", "bar");
  vi.stubEnv("LANGSMITH_NOTE", SECRET_LOOKING_VALUE);
  vi.stubEnv("LANGCHAIN_REVISION_ID", "rev-1");
  vi.stubEnv("LANGSMITH_PROJECT", "must-not-travel");
  vi.stubEnv("GITHUB_SHA", "abc123");
  vi.stubEnv("GIT_COMMIT", "");
  for (const [name, value] of Object.entries(SECRET_NAME_VALUES)) vi.stubEnv(name, value);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(privacyMode: "full" | "metadata"): PreparedRunPostSubmission {
  return {
    operation: "post",
    integration: "claude-code",
    privacyMode,
    metadata: {
      integration: "claude-code",
      threadId: "thread-1",
      agentType: "root",
      runType: "root",
      base: { LANGSMITH_FOO: "from-plugin" },
    },
    run: {
      id: RUN_ID,
      name: "root run",
      run_type: "chain",
      start_time: "2026-10-09T20:00:00.000Z",
      inputs: { prompt: "hello" },
    },
  };
}

function patch(privacyMode: "full" | "metadata"): PreparedRunPatchSubmission {
  const { run: _run, ...rest } = post(privacyMode);
  return {
    ...rest,
    operation: "patch",
    run: {
      id: RUN_ID,
      name: "root run",
      run_type: "chain",
      start_time: "2026-10-09T20:00:00.000Z",
    },
    privacyContext: { status: "completed" },
    patch: { fields: ["end_time"], values: { end_time: "2026-10-09T20:00:01.000Z" } },
  };
}

function writer(redact: boolean, replicas = false) {
  const options: LangSmithUploadWriterOptions = {
    redact,
    destinations: [{ apiKey: "synthetic-primary-key", apiUrl: endpoint, projectName: "primary" }],
    ...(replicas
      ? { replicas: [{ apiKey: "synthetic-replica-key", projectName: "replica" }] }
      : {}),
  };
  return createLangSmithUploadWriter(options);
}

const extraOf = (request: LocalRequest) => request.payload["extra"] as Record<string, unknown>;

describe("runtime metadata on the wire", () => {
  const cases = [
    ["post", post],
    ["patch", patch],
  ] as const;
  const expectedRuntime = {
    library: "langsmith",
    runtime: "node",
    sdk: "langsmith-js",
    sdk_version: __version__,
    GITHUB_SHA: "abc123",
    GIT_COMMIT: "",
  };

  for (const [operation, build] of cases) {
    for (const redact of [false, true]) {
      for (const replicas of [false, true]) {
        const label = `${operation}, ${redact ? "redacted" : "regular"} client, ${replicas ? "replica" : "primary"}`;

        it(`sends exactly the SDK runtime fields in full mode: ${label}`, async () => {
          const target = writer(redact, replicas);
          const id = target.destinations.at(replicas ? -1 : 0)!.id;
          await target.send(build("full"), id);
          const extra = extraOf(requests.at(-1)!);
          expect(extra["runtime"]).toEqual(expectedRuntime);
          expect(extra["metadata"]).toMatchObject({
            LANGSMITH_FOO: "from-plugin",
            revision_id: "rev-1",
            LANGSMITH_NOTE: redact ? "[SECRET_DETECTED]" : SECRET_LOOKING_VALUE,
          });
          expect(extra["metadata"]).not.toHaveProperty("LANGCHAIN_REVISION_ID");
          expect(extra["metadata"]).not.toHaveProperty("LANGSMITH_PROJECT");
          expect(extra["metadata"]).not.toHaveProperty("ls_tracing_sample_rate");
        });

        it(`adds nothing in muted mode: ${label}`, async () => {
          const target = writer(redact, replicas);
          const id = target.destinations.at(replicas ? -1 : 0)!.id;
          await target.send(build("metadata"), id);
          const body = JSON.stringify(requests.at(-1)!.payload);
          expect(extraOf(requests.at(-1)!)).not.toHaveProperty("runtime");
          for (const absent of ["LANGSMITH_FOO", "revision_id", "rev-1", "abc123", "bar"])
            expect(body).not.toContain(`"${absent}"`);
        });
      }
    }
  }

  it("never sends a secret-looking variable or its value", async () => {
    const target = writer(false);
    for (const send of [post("full"), patch("full")])
      await target.send(send, target.destinations[0]!.id);
    const body = requests.map(({ payload }) => JSON.stringify(payload)).join("\n");
    for (const [name, value] of Object.entries(SECRET_NAME_VALUES)) {
      expect(body).not.toContain(name);
      expect(body).not.toContain(value);
    }
  });

  it("reports the Bun runtime when it runs inside the compiled binary", async () => {
    vi.stubGlobal("Bun", {});
    const target = writer(false);
    await target.send(post("full"), target.destinations[0]!.id);
    expect(extraOf(requests.at(-1)!)["runtime"]).toMatchObject({ runtime: "bun" });
  });
});

const bunAvailable = spawnSync("bun", ["--version"]).status === 0;

it.skipIf(!bunAvailable)(
  "reports bun when the upload really runs under Bun",
  async () => {
    const child = spawn(
      "bun",
      [
        fileURLToPath(new URL("./fixtures/bun-upload.mjs", import.meta.url)),
        moduleUrl("dist/tracing/upload/index.js"),
        JSON.stringify({
          destination: {
            apiKey: "synthetic-primary-key",
            apiUrl: endpoint,
            projectName: "primary",
          },
          submission: post("full"),
        }),
      ],
      { env: { ...childEnvironment(temporaryRoot()), PATH: process.env.PATH }, stdio: "ignore" },
    );
    const status = await new Promise((resolve) => child.once("exit", resolve));
    expect(status).toBe(0);
    expect(extraOf(requests.at(-1)!)["runtime"]).toMatchObject({
      runtime: "bun",
      sdk_version: expect.any(String),
    });
  },
  30_000,
);
