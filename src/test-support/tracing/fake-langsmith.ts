import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { FakeLangSmith, ReceivedBatch } from "../models/tracer-queue.js";

export async function startFakeLangSmith(): Promise<FakeLangSmith> {
  const held: (() => void)[] = [];
  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      if (!request.url?.endsWith("/runs/batch")) return void response.end("{}");
      const payload = JSON.parse(body) as {
        post?: ReceivedBatch["posts"];
        patch?: ReceivedBatch["patches"];
      };
      const batch = { posts: payload.post ?? [], patches: payload.patch ?? [], body };
      fake.batches.push(batch);
      fake.inFlight += 1;
      fake.mostInFlight = Math.max(fake.mostInFlight, fake.inFlight);
      const answer = () => {
        fake.inFlight -= 1;
        if (fake.failuresLeft > 0) {
          fake.failuresLeft -= 1;
          response.writeHead(503).end("{}");
        } else if (fake.rejectMarker !== undefined && body.includes(fake.rejectMarker)) {
          response.writeHead(400).end("{}");
        } else {
          for (const posted of batch.posts) fake.stored.set(String(posted["id"]), posted);
          for (const patched of batch.patches) {
            const id = String(patched["id"]);
            fake.stored.set(id, { ...fake.stored.get(id), ...patched });
          }
          response.writeHead(200).end("{}");
        }
      };
      if (fake.holdResponses) held.push(answer);
      else answer();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("No server port");
  const fake: FakeLangSmith = {
    endpoint: `http://127.0.0.1:${address.port}/api/v1`,
    batches: [],
    stored: new Map(),
    inFlight: 0,
    mostInFlight: 0,
    failuresLeft: 0,
    rejectMarker: undefined,
    holdResponses: false,
    release: () => {
      fake.holdResponses = false;
      for (const answer of held.splice(0)) answer();
    },
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
  return fake;
}
