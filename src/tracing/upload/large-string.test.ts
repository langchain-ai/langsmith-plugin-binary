import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { childEnvironment, temporaryRoot } from "../../test-support/tracing/delivery.js";

const fixture = fileURLToPath(new URL("./fixtures/large-upload.mjs", import.meta.url));
const sourceLoader = new URL("./fixtures/ts-sources.mjs", import.meta.url).href;
const bunAvailable = spawnSync("bun", ["--version"]).status === 0;
let server: Server;
let url: string;
let requests: string[];

beforeEach(async () => {
  requests = [];
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not start");
  url = `http://127.0.0.1:${address.port}/api/v1`;
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
});

function run(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...childEnvironment(temporaryRoot()), PATH: process.env.PATH },
      stdio: "ignore",
    });
    child.once("exit", resolve);
  });
}

it("uploads a run holding a string over 70,000 characters from a process with nothing else running", async () => {
  await expect(run(process.execPath, ["--import", sourceLoader, fixture, url])).resolves.toBe(0);
  expect(requests).toEqual(["/api/v1/runs/batch"]);
}, 30_000);

it.skipIf(!bunAvailable)(
  "does the same under Bun and in a compiled Bun binary",
  async () => {
    await expect(run("bun", [fixture, url])).resolves.toBe(0);
    const binary = join(temporaryRoot(), "large-upload");
    const compiled = spawnSync("bun", ["build", fixture, "--compile", "--outfile", binary], {
      cwd: temporaryRoot(),
      env: { ...process.env, TMPDIR: temporaryRoot() },
    });
    expect(compiled.status).toBe(0);
    await expect(run(binary, [url])).resolves.toBe(0);
    expect(requests).toHaveLength(2);
  },
  60_000,
);
