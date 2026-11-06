import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { prepareClaude } from "./agents/claude.ts";
import { prepareCodex } from "./agents/codex.ts";
import { checkHooks, checkRuns } from "./check.ts";
import { waitForRuns } from "./langsmith.ts";
import type { AgentName, PreparedAgent, RunOptions, Scenario } from "./models.ts";
import { driveTerminal } from "./terminal.ts";
import { readEvents } from "./workspace.ts";

const preparers: Record<AgentName, (options: RunOptions) => PreparedAgent> = {
  claude: prepareClaude,
  codex: prepareCodex,
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function readOptions(): RunOptions {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      plugin: { type: "string" },
      scenario: { type: "string" },
      project: { type: "string" },
      "agent-command": { type: "string" },
    },
  });
  const agent = values.agent;
  if (agent !== "claude" && agent !== "codex") throw new Error("--agent must be claude or codex");
  if (!values.plugin || !values.scenario || !values.project) {
    throw new Error("--plugin, --scenario and --project are required");
  }
  return {
    agent,
    pluginDir: resolve(values.plugin),
    scenario: JSON.parse(readFileSync(values.scenario, "utf8")) as Scenario,
    project: values.project,
    workDir: mkdtempSync(join(tmpdir(), `plugin-qa-${agent}-`)),
    tracingApiKey: requiredEnv("QA_TRACING_API_KEY"),
    gatewayApiKey: requiredEnv("QA_GATEWAY_API_KEY"),
    agentCommand: values["agent-command"] ?? agent,
  };
}

const options = readOptions();
console.log(
  `running ${options.scenario.name} on ${options.agent} into ${options.project} (work folder ${options.workDir})`,
);
const { launch, eventsFile, secretFiles } = preparers[options.agent](options);
const prompts = options.scenario.turns.map((turn) => turn.prompt);
const failures = await driveTerminal(launch, prompts, eventsFile).finally(() => {
  for (const file of secretFiles) rmSync(file, { force: true });
});
failures.push(...checkHooks(options.scenario, options.agent, readEvents(eventsFile)));
const runs = await waitForRuns(
  options.tracingApiKey,
  options.project,
  options.scenario.turns.length,
);
failures.push(...checkRuns(options.scenario, runs));

if (failures.length > 0) {
  console.error(`FAIL ${options.scenario.name} on ${options.agent}\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`PASS ${options.scenario.name} on ${options.agent} (${runs.length} runs)`);
