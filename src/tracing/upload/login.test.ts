import { writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLoginNotice } from "../../auth/index.js";
import { RUN_ID } from "../../test-support/constants.js";
import { waitFor } from "../../test-support/wait.js";
import { temporaryFolder, writeLoginConfig } from "../../test-support/login.js";
import { createLangSmithUploadWriter } from "./index.js";
import { UploadError } from "./errors.js";
import type { PreparedRunPostSubmission } from "./models.js";

const EXPIRED_TOKEN = "synthetic-expired-access";
const FORBIDDEN_TOKEN = "synthetic-forbidden-access";
const BLIP_TOKEN = "synthetic-blip-access";
const BLIP_KEY = "synthetic-rejected-key";
const FORBIDDEN_KEY = "synthetic-forbidden-key";
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

function keyWriter(apiKey: string) {
  const writer = createLangSmithUploadWriter({
    redact: true,
    storageRoot,
    destinations: [{ apiKey, apiUrl: endpoint, projectName: "p" }],
  });
  return { writer, destination: writer.destinations[0]!.id };
}

function loginWriter(token: string, workspaceId?: string) {
  const configPath = writeLoginConfig(loginProfile(token));
  vi.stubEnv("LANGSMITH_CONFIG_FILE", configPath);
  const login = { configPath, profile: "work" };
  const workspace = workspaceId === undefined ? {} : { workspaceId };
  const writer = createLangSmithUploadWriter({
    redact: true,
    storageRoot,
    destinations: [{ login, apiUrl: endpoint, projectName: "p", ...workspace }],
  });
  return { writer, destination: writer.destinations[0]!.id, configPath };
}

beforeEach(async () => {
  storageRoot = temporaryFolder("login state ");
  blips = 0;
  headers = [];
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
      const forbiddenKey = request.headers["x-api-key"] === FORBIDDEN_KEY;
      response.writeHead(
        rejectedKey
          ? 401
          : forbiddenKey
            ? 403
            : (status[request.headers.authorization ?? ""] ?? 200),
      );
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
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

  it("uploads with the chosen profile's token and workspace, not the CLI's current one", async () => {
    const configPath = writeLoginConfig(loginProfile("synthetic-access"));
    const other = { ...loginProfile("synthetic-other-access"), workspace_id: "other-workspace" };
    const work = loginProfile("synthetic-access");
    writeFileSync(
      configPath,
      JSON.stringify({ current_profile: "other", profiles: { work, other } }),
    );
    vi.stubEnv("LANGSMITH_PROFILE", "other");
    vi.stubEnv("LANGSMITH_API_KEY", "synthetic-shell-key");
    const configFile = process.env["LANGSMITH_CONFIG_FILE"];
    const login = { configPath, profile: "work", workspaceId: "configured-workspace" };
    const writer = createLangSmithUploadWriter({
      redact: true,
      storageRoot,
      destinations: [{ login, apiUrl: endpoint, projectName: "p" }],
    });
    await writer.send(submission, writer.destinations[0]!.id);
    expect(headers[0]).toMatchObject({
      authorization: "Bearer synthetic-access",
      "x-tenant-id": "configured-workspace",
    });
    expect(headers[0]).not.toHaveProperty("x-api-key");
    expect(process.env.LANGSMITH_PROFILE).toBe("other");
    expect(process.env["LANGSMITH_CONFIG_FILE"]).toBe(configFile);
  });

  it("drops a trace the server rejects for an expired login and pauses tracing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { writer, destination } = loginWriter(EXPIRED_TOKEN);
    const failure = await writer.send(submission, destination).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UploadError);
    expect(failure).toMatchObject({ status: 401, retryable: false, loginRejected: true });
    await waitFor(
      () => readLoginNotice(storageRoot)?.includes("login expired"),
      "the paused notice",
    );
  });

  it("clears the paused notice once an upload with the login succeeds again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { writer, destination } = loginWriter(BLIP_TOKEN);
    await writer.send(submission, destination).catch(() => undefined);
    await waitFor(
      () => readLoginNotice(storageRoot)?.includes("login expired"),
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
      () =>
        readLoginNotice(storageRoot, {}, { apiKey: BLIP_KEY, apiUrl: endpoint })?.includes(
          "API key was rejected",
        ),
      "the key notice",
    );
    await writer.send(submission, destination);
    await waitFor(
      () => readLoginNotice(storageRoot, {}, { apiKey: BLIP_KEY, apiUrl: endpoint }) === undefined,
      "the key notice to clear",
    );
  });

  it("sends the login instead of a generic environment key the SDK reads on its own", async () => {
    vi.stubEnv("LANGSMITH_API_KEY", "synthetic-environment-key");
    vi.stubEnv("LANGCHAIN_API_KEY", "synthetic-legacy-key");
    const { writer, destination } = loginWriter("synthetic-access");
    await writer.send(submission, destination);
    expect(headers[0]).toMatchObject({ authorization: "Bearer synthetic-access" });
    expect(headers[0]).not.toHaveProperty("x-api-key");
    expect(process.env["LANGSMITH_API_KEY"]).toBe("synthetic-environment-key");
  });

  it("pauses with the no-access message, not the expired one, when a login or key gets a 403", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { writer, destination } = loginWriter(FORBIDDEN_TOKEN);
    const failure = await writer.send(submission, destination).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 403, retryable: false, loginRejected: false });
    await waitFor(
      () => readLoginNotice(storageRoot)?.includes("denied access") === true,
      "the login no-access notice",
    );
    const key = keyWriter(FORBIDDEN_KEY);
    await key.writer.send(submission, key.destination).catch(() => undefined);
    const forbidden = { apiKey: FORBIDDEN_KEY, apiUrl: endpoint };
    await waitFor(
      () => readLoginNotice(storageRoot, {}, forbidden)?.includes("denied access") === true,
      "the key no-access notice",
    );
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

  it("keeps the paused notice when a batch with nothing to send goes through", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { writer, destination } = loginWriter(EXPIRED_TOKEN);
    await writer.send(submission, destination).catch(() => undefined);
    await waitFor(
      () => readLoginNotice(storageRoot)?.includes("login expired"),
      "the paused notice",
    );
    await writer.sendBatch([], destination);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readLoginNotice(storageRoot)).toContain("login expired");
  });

  it("doesn't mark a refreshed login expired when its old access token is rejected", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { writer, destination, configPath } = loginWriter(EXPIRED_TOKEN);
    const refreshed = {
      access_token: "synthetic-refreshed",
      refresh_token: `${EXPIRED_TOKEN}-refresh`,
    };
    writeLoginConfig({ ...loginProfile(EXPIRED_TOKEN), oauth: refreshed }, configPath);
    const failure = await writer.send(submission, destination).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 401, loginRejected: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readLoginNotice(storageRoot)).toBeUndefined();
  });

  it("keeps a key's rejection for its own server only, even when a different key uploads fine", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rejected = keyWriter(BLIP_KEY);
    await rejected.writer.send(submission, rejected.destination).catch(() => undefined);
    await waitFor(
      () =>
        readLoginNotice(storageRoot, {}, { apiKey: BLIP_KEY, apiUrl: endpoint })?.includes(
          "API key was rejected",
        ),
      "the key notice",
    );
    const working = keyWriter("synthetic-working-key");
    await working.writer.send(submission, working.destination);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readLoginNotice(storageRoot, {}, { apiKey: BLIP_KEY, apiUrl: endpoint })).toContain(
      "API key was rejected",
    );
    const notice = (apiKey: string, apiUrl: string) =>
      readLoginNotice(storageRoot, {}, { apiKey, apiUrl });
    expect(notice("synthetic-working-key", endpoint)).toBeUndefined();
    expect(notice(BLIP_KEY, `${endpoint}/api/v1/`)).toContain("API key was rejected");
    expect(notice(BLIP_KEY, "https://other.example")).toBeUndefined();
  });

  it("drops a rejected key's notice once the CLI login is in use", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rejected = keyWriter(BLIP_KEY);
    await rejected.writer.send(submission, rejected.destination).catch(() => undefined);
    await waitFor(
      () =>
        readLoginNotice(storageRoot, {}, { apiKey: BLIP_KEY, apiUrl: endpoint })?.includes(
          "API key was rejected",
        ),
      "the key notice",
    );
    const { writer, destination } = loginWriter("synthetic-access");
    expect(readLoginNotice(storageRoot)).toBeUndefined();
    await writer.send(submission, destination);
    await waitFor(
      () => readLoginNotice(storageRoot, {}, { apiKey: BLIP_KEY, apiUrl: endpoint }) === undefined,
      "the stale key notice to clear",
    );
  });
});
