import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { claudeTracingEnvironment } from "./agents/claude.ts";
import { codexTracingEnvironment } from "./agents/codex.ts";
import { checkRuns } from "./check.ts";
import {
  FAKE_API_KEY,
  TURN_SETTLE_POLL_MS,
  TURN_SETTLE_TIMEOUT_MS,
  UPLOAD_QUIET_MS,
  UPLOAD_TIMEOUT_MS,
} from "./constants.ts";
import { startFakeServer } from "./fake/server.ts";
import { uploadsSettled } from "./langsmith.ts";
import type {
  AgentName,
  FakeServer,
  ReplayPlan,
  Scenario,
  TracingSettings,
  TranscriptLine,
} from "./models.ts";
import { claudePlan } from "./replay/claude-plan.ts";
import { codexPlan } from "./replay/codex-plan.ts";
import { pluginHookCommands, runHookCommand } from "./replay/hooks.ts";
import { baseEnvironment } from "./workspace.ts";

const planners: Record<AgentName, (lines: TranscriptLine[]) => ReplayPlan> = {
  claude: claudePlan,
  codex: codexPlan,
};
const tracingEnvironments: Record<
  AgentName,
  (settings: TracingSettings) => Record<string, string>
> = {
  claude: claudeTracingEnvironment,
  codex: codexTracingEnvironment,
};

function transcriptFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .flatMap((name) => transcriptFiles(join(path, name)))
    .filter((file) => file.endsWith(".jsonl"));
}

async function waitForQuietUploads(server: FakeServer, expectedRoots: number): Promise<void> {
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  let seen = -1;
  while (Date.now() < deadline) {
    const runs = server.runs();
    if (runs.length === seen && uploadsSettled(runs, expectedRoots)) return;
    seen = runs.length;
    await sleep(UPLOAD_QUIET_MS);
  }
}

async function waitForTurnUpload(server: FakeServer, finishedTurns: number): Promise<void> {
  const deadline = Date.now() + TURN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline && !uploadsSettled(server.runs(), finishedTurns)) {
    await sleep(TURN_SETTLE_POLL_MS);
  }
}

async function replaySession(
  agent: AgentName,
  pluginDir: string,
  file: string,
): Promise<string[] | undefined> {
  const rawLines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim());
  const plan = planners[agent](rawLines.map((line) => JSON.parse(line) as TranscriptLine));
  if (plan.turns.length === 0) return undefined;
  const scenario: Scenario = {
    name: basename(file),
    files: {},
    turns: plan.turns,
    hooksPerTurn: { claude: [], codex: [] },
  };
  const server = await startFakeServer(scenario);
  const workDir = mkdtempSync(join(tmpdir(), `plugin-qa-replay-${agent}-`));
  const project = join(workDir, "project");
  const transcript = join(workDir, basename(file));
  mkdirSync(project);
  writeFileSync(transcript, "");
  const settings: TracingSettings = {
    pluginDir,
    project: scenario.name,
    tracingApiKey: FAKE_API_KEY,
    endpoints: { tracing: server.url, anthropic: server.url, openai: server.url },
  };
  const env = {
    ...baseEnvironment(join(workDir, "home")),
    ...tracingEnvironments[agent](settings),
  };
  const commands = pluginHookCommands(pluginDir);

  let written = 0;
  let finishedTurns = 0;
  for (const event of plan.events) {
    appendFileSync(
      transcript,
      rawLines
        .slice(written, event.transcriptLines)
        .map((line) => `${line}\n`)
        .join(""),
    );
    written = Math.max(written, event.transcriptLines);
    const payload = JSON.stringify({ ...event.payload, transcript_path: transcript, cwd: project });
    for (const command of commands.get(String(event.payload.hook_event_name)) ?? []) {
      await runHookCommand(command, payload, project, env);
    }
    if (event.payload.hook_event_name === "Stop") await waitForTurnUpload(server, ++finishedTurns);
  }
  await waitForQuietUploads(server, plan.turns.length);
  const failures = checkRuns(scenario, server.runs());
  await server.close();
  return failures;
}

const { values } = parseArgs({
  options: { agent: { type: "string" }, plugin: { type: "string" }, sessions: { type: "string" } },
});
const agent = values.agent;
if (agent !== "claude" && agent !== "codex") throw new Error("--agent must be claude or codex");
if (!values.plugin || !values.sessions) throw new Error("--plugin and --sessions are required");

let failed = 0;
const files = transcriptFiles(resolve(values.sessions));
for (const file of files) {
  const failures = await replaySession(agent, resolve(values.plugin), file);
  if (failures === undefined) {
    console.log(`SKIP ${basename(file)} (no user turns)`);
    continue;
  }
  if (failures.length > 0) failed += 1;
  console.log(
    failures.length === 0
      ? `PASS ${basename(file)}`
      : `FAIL ${basename(file)}\n- ${failures.join("\n- ")}`,
  );
}
console.log(`${failed} of ${files.length} sessions failed`);
if (failed > 0) process.exit(1);
