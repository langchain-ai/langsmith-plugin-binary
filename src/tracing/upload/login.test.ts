import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLoginNotice } from "../../auth/index.js";
import { RUN_ID } from "../../test-support/constants.js";
import { waitFor } from "../../test-support/wait.js";
import { fakeTool, temporaryFolder, writeLoginConfig } from "../../test-support/login.js";
import { setDesktopLauncherForTests } from "../../utils/desktop/notification.js";
import { createLangSmithUploadWriter } from "./index.js";
import { UploadError } from "./errors.js";
import type { PreparedRunPostSubmission } from "./models.js";

const launched = vi.fn<(command: string) => undefined>();

const EXPIRED_TOKEN = "synthetic-expired-access";
const FORBIDDEN_TOKEN = "synthetic-forbidden-access";
const BLIP_TOKEN = "synthetic-blip-access";
const BLIP_KEY = "synthetic-rejected-key";
let server: ReturnType<typeof createServer>;
let endpoint: string;
let headers: IncomingHttpHeaders[];
let blips = 0;
let storageRoot: string;

const submission: PreparedRunPostSubmission = {
  operation: "post",
  integration: "openai-codex",
  privacyMode: "metadata",
  run: { id: RUN_ID, name: "root run", run_type: "chain", inputs: {} },
  metadata: {
    integration: "openai-codex",
    threadId: "thread-1",
    turnId: "turn-1",
    agentType: "root",
    runType: "root",
  },
};

function loginProfile(token: string) {
  return {
    api_url: endpoint,
    workspace_id: "login-workspace",
    oauth: { access_token: token, refresh_token: `${token}-refresh` },
  };
}

function loginWriter(token: string, workspaceId?: string) {
  const configPath = writeLoginConfig(loginProfile(token));
  vi.stubEnv("LANGSMITH_CONFIG_FILE", configPath);
  const login = { configPath, profile: "work" };
  const workspace = workspaceId === undefined ? {} : { workspaceId };
  const writer = createLangSmithUploadWriter({
    redact: true,
    loginBrowser: false,
    storageRoot,
    destinations: [{ login, apiUrl: endpoint, projectName: "p", ...workspace }],
  });
  return { writer, destination: writer.destinations[0]!.id, configPath };
}

beforeEach(async () => {
  launched.mockClear();
  setDesktopLauncherForTests(launched);
  storageRoot = temporaryFolder("login state ");
  blips = 0;
  headers = [];
  vi.stubEnv("PATH", "");
  server = createServer((request, response) => {
    headers.push(request.headers);
    request.resume();
    request.on("end", () => {
      const blip =
        (request.headers.authorization === `Bearer ${BLIP_TOKEN}` ||
          request.headers["x-api-key"] === BLIP_KEY) &&
        blips++ === 0;
      const status: Record<string, number> = {
        [`Bearer ${EXPIRED_TOKEN}`]: 401,
        [`Bearer ${FORBIDDEN_TOKEN}`]: 403,
        ...(blip ? { [`Bearer ${BLIP_TOKEN}`]: 401 } : {}),
      };
      const rejectedKey = blip && request.headers["x-api-key"] === BLIP_KEY;
      response.writeHead(rejectedKey ? 401 : (status[request.headers.authorization ?? ""] ?? 200));
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  setDesktopLauncherForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("uploading with the LangSmith CLI login", () => {
  it("sends the login's token and workspace instead of blanking them", async () => {
    const { writer, destination } = loginWriter("synthetic-access");
    await writer.send(submission, destination);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({
      authorization: "Bearer synthetic-access",
      "x-tenant-id": "login-workspace",
    });
    expect(headers[0]).not.toHaveProperty("x-api-key");
  });

  it("sends a configured workspace instead of the login's own", async () => {
    const { writer, destination } = loginWriter("synthetic-access", "configured-workspace");
    await writer.send(submission, destination);
    expect(headers[0]).toMatchObject({ "x-tenant-id": "configured-workspace" });
  });

  it("drops a trace the server rejects for an expired login and pauses tracing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("PATH", fakeTool("langsmith"));
    vi.stubEnv("DISPLAY", ":0");
    const { writer, destination } = loginWriter(EXPIRED_TOKEN);
    const failure = await writer.send(submission, destination).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UploadError);
    expect(failure).toMatchObject({ status: 401, retryable: false, loginRejected: true });
    await waitFor(
      () => readLoginNotice(storageRoot)?.includes("token expired"),
      "the paused notice",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(launched.mock.calls.filter(([command]) => command.endsWith("langsmith"))).toEqual([]);
  });

  it("clears the paused notice once an upload with the login succeeds again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { writer, destination } = loginWriter(BLIP_TOKEN);
    await writer.send(submission, destination).catch(() => undefined);
    await waitFor(
      () => readLoginNotice(storageRoot)?.includes("token expired"),
      "the paused notice",
    );
    await writer.send(submission, destination);
    await waitFor(() => readLoginNotice(storageRoot) === undefined, "the notice to clear");
  });

  it("says a rejected API key needs replacing until an upload with a key works again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writer = createLangSmithUploadWriter({
      redact: true,
      storageRoot,
      destinations: [{ apiKey: BLIP_KEY, apiUrl: endpoint, projectName: "p" }],
    });
    const destination = writer.destinations[0]!.id;
    await writer.send(submission, destination).catch(() => undefined);
    await waitFor(
      () => readLoginNotice(storageRoot)?.includes("API key was rejected"),
      "the key notice",
    );
    await writer.send(submission, destination);
    await waitFor(() => readLoginNotice(storageRoot) === undefined, "the key notice to clear");
  });

  it("refuses a login destination the SDK would send with an environment key instead", () => {
    vi.stubEnv("LANGSMITH_API_KEY", "synthetic-environment-key");
    expect(() => loginWriter("synthetic-access")).toThrow("CLI login");
  });

  it("treats a 403 as no access, not an expired login", async () => {
    const { writer, destination } = loginWriter(FORBIDDEN_TOKEN);
    const failure = await writer.send(submission, destination).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 403, retryable: false, loginRejected: false });
    expect(readLoginNotice(storageRoot)).toBeUndefined();
  });

  it("doesn't mark a new sign-in expired when an uploader still sends the old token", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { writer, destination, configPath } = loginWriter(EXPIRED_TOKEN);
    writeLoginConfig(loginProfile("synthetic-new-access"), configPath);
    const failure = await writer.send(submission, destination).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 401, loginRejected: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readLoginNotice(storageRoot)).toBeUndefined();
  });
});
