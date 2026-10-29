import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FAKE_SERVER_INFO } from "../constants.ts";
import type { FakeServer, RunBatch, Scenario } from "../models.ts";
import { anthropicStream } from "./anthropic.ts";
import { RunCapture } from "./langsmith.ts";
import { responsesStream } from "./openai.ts";
import { nextStep } from "./script.ts";

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

export async function startFakeServer(scenario: Scenario): Promise<FakeServer> {
  const capture = new RunCapture();
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    if (path === "/v1/messages") {
      const model = String((JSON.parse(body) as { model?: string }).model);
      send(response, 200, "text/event-stream", anthropicStream(nextStep(scenario, body), model));
    } else if (path === "/v1/responses") {
      send(response, 200, "text/event-stream", responsesStream(nextStep(scenario, body)));
    } else if (path === "/info") {
      send(response, 200, "application/json", JSON.stringify(FAKE_SERVER_INFO));
    } else if (path === "/runs/batch") {
      capture.receiveBatch(JSON.parse(body) as RunBatch);
      send(response, 202, "application/json", "{}");
    } else {
      send(response, 404, "application/json", "{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    runs: () => capture.runs(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
