import { writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { RUN_ID } from "../../test-support/constants.js";
import { temporaryFolder } from "../../test-support/login.js";
import { createLangSmithUploadWriter } from "./index.js";
import type { PreparedRunPostSubmission } from "./models.js";

const LOGIN_TOKEN = "synthetic-login-token";
const headers: IncomingHttpHeaders[] = [];
const server = createServer((request, response) => {
  headers.push(request.headers);
  request.resume();
  request.on("end", () => response.writeHead(200).end("{}"));
});
let endpoint: string;

const submission: PreparedRunPostSubmission = {
  operation: "post",
  integration: "openai-codex",
  privacyMode: "metadata",
  run: { id: RUN_ID, name: "root run", run_type: "chain", inputs: {} },
  metadata: {
    integration: "openai-codex",
    threadId: "t",
    turnId: "u",
    agentType: "root",
    runType: "root",
  },
};

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const configPath = join(temporaryFolder("sdk key login "), "config.json");
  const profile = { api_url: endpoint, oauth: { access_token: LOGIN_TOKEN } };
  writeFileSync(
    configPath,
    JSON.stringify({ current_profile: "work", profiles: { work: profile } }),
  );
  vi.stubEnv("LANGSMITH_CONFIG_FILE", configPath);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it.each(['""', '""""', `"''"`, "' '", "   "])(
  "never lets the API key %j fall back to the CLI login inside the SDK",
  async (apiKey) => {
    headers.length = 0;
    try {
      const writer = createLangSmithUploadWriter({
        redact: true,
        destinations: [{ apiKey, apiUrl: endpoint, projectName: "p" }],
      });
      await writer.send(submission, writer.destinations[0]!.id);
    } catch {}
    expect(headers.map(({ authorization }) => authorization)).not.toContain(
      `Bearer ${LOGIN_TOKEN}`,
    );
  },
);
