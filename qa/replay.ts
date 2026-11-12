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
  BUNDLED_BINARY_WARNING,
  BYTES_PER_MEGABYTE,
  FAKE_API_KEY,
  PROMPT_EVENT,
  STOP_EVENT,
  TURN_SETTLE_POLL_MS,
  TURN_SETTLE_TIMEOUT_MS,
} from "./constants.ts";
import { startFakeServer, waitForQuietUploads } from "./fake/server.ts";
import { uploadsSettled } from "./langsmith.ts";
import type {
  AgentName,
  EngineUsage,
  FakeServer,
  ReplayOptions,
  ReplayPlan,
  ReplayPlanner,
  Scenario,
  TracingEnvironment,
  TracingSettings,
  TranscriptLine,
} from "./models.ts";
import { claudePlan } from "./replay/claude-plan.ts";
import { codexPlan } from "./replay/codex-plan.ts";
import { pluginHookCommands, runHookCommand } from "./replay/hooks.ts";
import { closeUsageGroup, commandInGroup, createUsageGroup, usageSummary } from "./replay/usage.ts";
import { baseEnvironment } from "./workspace.ts";

const planners: Record<AgentName, ReplayPlanner> = {
  claude: claudePlan,
  codex: codexPlan,
};
const tracingEnvironments: Record<AgentName, TracingEnvironment> = {
  claude: claudeTracingEnvironment,
  codex: codexTracingEnvironment,
};

function transcriptFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .flatMap((name) => transcriptFiles(join(path, name)))
    .filter((file) => file.endsWith(".jsonl"));
}

async function waitForTurnUpload(server: FakeServer, finishedTurns: number): Promise<void> {
  const deadline = Date.now() + TURN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline && !uploadsSettled(server.runs(), finishedTurns)) {
    await sleep(TURN_SETTLE_POLL_MS);
  }
}

function skipReason(plan: ReplayPlan): string | undefined {
  if (plan.turns.length === 0) return "no user turns";
  const lastPrompt = plan.events.findLastIndex(
    (event) => event.payload.hook_event_name === PROMPT_EVENT,
  );
  const finished = plan.events
    .slice(lastPrompt)
    .some((event) => event.payload.hook_event_name === STOP_EVENT);
  return finished ? undefined : "ends mid-turn";
}

function profilingEnvironment(profileDir: string): Record<string, string> {
  return {
    NODE_OPTIONS: `--cpu-prof --cpu-prof-dir="${profileDir}" --heap-prof --heap-prof-dir="${profileDir}"`,
  };
}

async function replaySession(
  options: ReplayOptions,
  file: string,
  rawLines: string[],
  plan: ReplayPlan,
  usageGroup: string | undefined,
): Promise<string[]> {
  const { agent, pluginDir } = options;
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
    ...(options.profileDir === undefined ? {} : profilingEnvironment(options.profileDir)),
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
      const measured = usageGroup === undefined ? command : commandInGroup(usageGroup, command);
      const exitCode = await runHookCommand(measured, payload, project, env);
      if (exitCode !== 0)
        console.warn(`${event.payload.hook_event_name} hook exited with ${exitCode}`);
    }
    if (event.payload.hook_event_name === STOP_EVENT)
      await waitForTurnUpload(server, ++finishedTurns);
  }
  await waitForQuietUploads(server, plan.turns.length);
  const failures = checkRuns(scenario, server.runs());
  await server.close();
  return failures;
}

const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    plugin: { type: "string" },
    sessions: { type: "string", multiple: true },
    cgroup: { type: "string" },
    "profile-dir": { type: "string" },
  },
});
const agent = values.agent;
if (process.platform !== "linux") console.warn(BUNDLED_BINARY_WARNING);
if (agent !== "claude" && agent !== "codex") throw new Error("--agent must be claude or codex");
if (!values.plugin || !values.sessions?.length)
  throw new Error("--plugin and --sessions are required");
const options: ReplayOptions = {
  agent,
  pluginDir: resolve(values.plugin),
  profileDir: values["profile-dir"] === undefined ? undefined : resolve(values["profile-dir"]),
};

let failed = 0;
let replayed = 0;
const usages: EngineUsage[] = [];
const files = values.sessions.flatMap((sessions) => transcriptFiles(resolve(sessions)));
for (const file of files) {
  const rawLines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim());
  const plan = planners[agent](rawLines.map((line) => JSON.parse(line) as TranscriptLine));
  const reason = skipReason(plan);
  if (reason !== undefined) {
    console.log(`SKIP ${basename(file)} (${reason})`);
    continue;
  }
  const usageGroup =
    values.cgroup === undefined
      ? undefined
      : createUsageGroup(values.cgroup, `session-${replayed}`);
  const failures = await replaySession(options, file, rawLines, plan, usageGroup);
  replayed += 1;
  if (usageGroup !== undefined) {
    const usage = await closeUsageGroup(usageGroup);
    usages.push(usage);
    const megabytes = (usage.peakMemoryBytes / BYTES_PER_MEGABYTE).toFixed(1);
    console.log(`usage ${basename(file)}: ${usage.cpuMs} ms CPU, ${megabytes} MB peak memory`);
    if (usage.cpuMs === 0) failures.push("no plugin process was measured");
    if (!usage.exitedOnItsOwn)
      failures.push("a plugin process was still running after the session");
  }
  if (failures.length > 0) failed += 1;
  console.log(
    failures.length === 0
      ? `PASS ${basename(file)}`
      : `FAIL ${basename(file)}\n- ${failures.join("\n- ")}`,
  );
}
if (usages.length > 0) console.log(`percentiles ${usageSummary(usages)}`);
console.log(`${failed} of ${replayed} replayed sessions failed`);
if (failed > 0 || replayed === 0) process.exit(1);
