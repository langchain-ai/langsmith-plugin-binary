import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { prepareClaude } from "./agents/claude.ts";
import { prepareCodex } from "./agents/codex.ts";
import { checkHooks, checkRuns } from "./check.ts";
import { FAKE_API_KEY, TURN_TIMEOUT_MS, UPLOAD_POLL_MS, UPLOAD_TIMEOUT_MS } from "./constants.ts";
import { startFakeServer } from "./fake/server.ts";
import { uploadsSettled } from "./langsmith.ts";
import type { AgentName, FakeServer, PreparedAgent, RunOptions, Scenario } from "./models.ts";
import { readEvents } from "./workspace.ts";

const preparers: Record<AgentName, (options: RunOptions) => PreparedAgent> = {
  claude: prepareClaude,
  codex: prepareCodex,
};

function runTurn(prepared: PreparedAgent, args: string[]): Promise<number | null> {
  const child = spawn(prepared.launch.command, args, {
    cwd: prepared.launch.cwd,
    env: prepared.launch.env,
    stdio: "ignore",
    timeout: TURN_TIMEOUT_MS,
  });
  return new Promise((done) => child.on("close", done));
}

async function waitForUploads(server: FakeServer, expectedRoots: number): Promise<void> {
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  while (Date.now() < deadline && !uploadsSettled(server.runs(), expectedRoots)) {
    await sleep(UPLOAD_POLL_MS);
  }
  await sleep(UPLOAD_POLL_MS);
}

const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    plugin: { type: "string" },
    scenario: { type: "string" },
    "agent-command": { type: "string" },
  },
});
const agent = values.agent;
if (agent !== "claude" && agent !== "codex") throw new Error("--agent must be claude or codex");
if (!values.plugin || !values.scenario) throw new Error("--plugin and --scenario are required");
const scenario = JSON.parse(readFileSync(values.scenario, "utf8")) as Scenario;
const server = await startFakeServer(scenario);
const options: RunOptions = {
  agent,
  pluginDir: resolve(values.plugin),
  scenario,
  project: scenario.name,
  workDir: mkdtempSync(join(tmpdir(), `plugin-qa-headless-${agent}-`)),
  tracingApiKey: FAKE_API_KEY,
  gatewayApiKey: FAKE_API_KEY,
  agentCommand: values["agent-command"] ?? agent,
  endpoints: { tracing: server.url, anthropic: server.url, openai: `${server.url}/v1` },
};
console.log(`running ${scenario.name} headless on ${agent} (work folder ${options.workDir})`);

const prepared = preparers[agent](options);
const failures: string[] = [];
for (const [index, turn] of scenario.turns.entries()) {
  const exitCode = await runTurn(prepared, prepared.headlessArgs(turn.prompt, index));
  if (exitCode !== 0) failures.push(`turn ${index + 1} exited with ${exitCode}`);
}
for (const file of prepared.secretFiles) rmSync(file, { force: true });
await waitForUploads(server, scenario.turns.length);
failures.push(...checkHooks(scenario, agent, readEvents(prepared.eventsFile)));
failures.push(...checkRuns(scenario, server.runs()));
await server.close();

if (failures.length > 0) {
  console.error(`FAIL ${scenario.name} headless on ${agent}\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`PASS ${scenario.name} headless on ${agent} (${server.runs().length} runs)`);
