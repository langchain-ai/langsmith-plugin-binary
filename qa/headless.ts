import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { prepareClaude } from "./agents/claude.ts";
import { prepareCodex } from "./agents/codex.ts";
import { checkHooks, checkRuns } from "./check.ts";
import {
  BUNDLED_BINARY_WARNING,
  FAKE_API_KEY,
  SCREEN_TAIL_CHARS,
  TURN_TIMEOUT_MS,
} from "./constants.ts";
import { startFakeServer, waitForQuietUploads } from "./fake/server.ts";
import type { AgentName, PreparedAgent, RunOptions, Scenario, TurnResult } from "./models.ts";
import { readEvents } from "./workspace.ts";

const preparers: Record<AgentName, (options: RunOptions) => PreparedAgent> = {
  claude: prepareClaude,
  codex: prepareCodex,
};

function runTurn(prepared: PreparedAgent, args: string[]): Promise<TurnResult> {
  const child = spawn(prepared.launch.command, args, {
    cwd: prepared.launch.cwd,
    env: prepared.launch.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TURN_TIMEOUT_MS,
  });
  let output = "";
  const keepTail = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-SCREEN_TAIL_CHARS);
  };
  child.stdout.on("data", keepTail);
  child.stderr.on("data", keepTail);
  return new Promise((done) =>
    child.on("exit", (exitCode) => done({ exitCode, outputTail: output })),
  );
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
if (process.platform !== "linux") console.warn(BUNDLED_BINARY_WARNING);
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
  const result = await runTurn(prepared, prepared.headlessArgs(turn.prompt, index));
  if (result.exitCode !== 0)
    failures.push(`turn ${index + 1} exited with ${result.exitCode}:\n${result.outputTail}`);
}
for (const file of prepared.secretFiles) rmSync(file, { force: true });
await waitForQuietUploads(server, scenario.turns.length);
failures.push(...checkHooks(scenario, agent, readEvents(prepared.eventsFile)));
failures.push(...checkRuns(scenario, server.runs()));
await server.close();

if (failures.length > 0) {
  console.error(`FAIL ${scenario.name} headless on ${agent}\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`PASS ${scenario.name} headless on ${agent} (${server.runs().length} runs)`);
