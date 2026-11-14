import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { claudeTracingEnvironment } from "./agents/claude.ts";
import { codexTracingEnvironment } from "./agents/codex.ts";
import { cursorTracingEnvironment } from "./agents/cursor.ts";
import { checkRuns } from "./check.ts";
import {
  BUNDLED_BINARY_WARNING,
  BYTES_PER_MEGABYTE,
  FAKE_API_KEY,
  SUBAGENT_FILE_PREFIX,
  SUBAGENT_METADATA_EXTENSION,
  SUBAGENTS_FOLDER,
  TRANSCRIPT_EXTENSION,
  TURN_EVENTS,
  TURN_SETTLE_POLL_MS,
  TURN_SETTLE_TIMEOUT_MS,
} from "./constants.ts";
import { startFakeServer, waitForQuietUploads } from "./fake/server.ts";
import { uploadsSettled } from "./langsmith.ts";
import type {
  EngineUsage,
  FakeServer,
  ReplayOptions,
  ReplayPlan,
  ReplayAgentName,
  ReplayPlanner,
  ReplayTranscript,
  Scenario,
  SubagentReader,
  TracingEnvironment,
  TracingSettings,
  TranscriptLine,
  TurnEvents,
} from "./models.ts";
import { claudePlan } from "./replay/claude-plan.ts";
import { codexPlan } from "./replay/codex-plan.ts";
import { cursorPlan } from "./replay/cursor-plan.ts";
import { pluginHookCommands, runHookCommand } from "./replay/hooks.ts";
import { closeUsageGroup, commandInGroup, createUsageGroup, usageSummary } from "./replay/usage.ts";
import { forEachInParallel } from "./utils/pool.ts";
import { baseEnvironment } from "./workspace.ts";

const planners: Record<ReplayAgentName, ReplayPlanner> = {
  claude: claudePlan,
  codex: codexPlan,
  cursor: cursorPlan,
};
const tracingEnvironments: Record<ReplayAgentName, TracingEnvironment> = {
  claude: claudeTracingEnvironment,
  codex: codexTracingEnvironment,
  cursor: cursorTracingEnvironment,
};

function transcriptFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((name) => name !== SUBAGENTS_FOLDER)
    .flatMap((name) => transcriptFiles(join(path, name)))
    .filter((file) => file.endsWith(TRANSCRIPT_EXTENSION));
}

function readTranscript(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim());
}

function subagentFile(folder: string, agentId: string): string {
  return join(folder, `${SUBAGENT_FILE_PREFIX}${agentId}${TRANSCRIPT_EXTENSION}`);
}

function subagentReader(file: string): SubagentReader {
  const folder = join(dirname(file), basename(file, TRANSCRIPT_EXTENSION), SUBAGENTS_FOLDER);
  return (agentId) => {
    const path = subagentFile(folder, agentId);
    return existsSync(path) ? readTranscript(path) : undefined;
  };
}

function gapOption(name: string, value: string): number {
  const gap = Number(value);
  if (value.trim() === "" || !Number.isFinite(gap) || gap < 0)
    throw new Error(`--${name} must be a number of milliseconds of at least 0`);
  return gap;
}

async function waitForTurnUpload(server: FakeServer, finishedTurns: number): Promise<void> {
  const deadline = Date.now() + TURN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline && !uploadsSettled(server.runs(), finishedTurns)) {
    await sleep(TURN_SETTLE_POLL_MS);
  }
}

function skipReason(plan: ReplayPlan, turnEvents: TurnEvents): string | undefined {
  if (plan.turns.length === 0) return "no user turns";
  const lastPrompt = plan.events.findLastIndex(
    (event) => event.payload.hook_event_name === turnEvents.prompt,
  );
  const finished = plan.events
    .slice(lastPrompt)
    .some((event) => event.payload.hook_event_name === turnEvents.stop);
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
  const turnEvents = TURN_EVENTS[agent];
  const sessionId = options.freshSessionId && plan.sessionId !== "" ? randomUUID() : plan.sessionId;
  const renamed = (text: string) => text.replaceAll(plan.sessionId, sessionId);
  const scenario: Scenario = {
    name: basename(file),
    files: {},
    turns: plan.turns,
    hooksPerTurn: { claude: [], codex: [] },
  };
  const server = await startFakeServer(scenario);
  const workDir = mkdtempSync(join(tmpdir(), `plugin-qa-replay-${agent}-`));
  const project = join(workDir, "project");
  const transcript = join(workDir, renamed(basename(file)));
  mkdirSync(project);
  writeFileSync(transcript, "");
  const outputs = new Map<string | undefined, ReplayTranscript>([
    [undefined, { path: transcript, lines: rawLines.map(renamed) }],
  ]);
  const subagentFolder = join(workDir, sessionId, SUBAGENTS_FOLDER);
  for (const { agentId, toolUseId, agentType, lines } of plan.subagents) {
    const path = subagentFile(subagentFolder, agentId);
    mkdirSync(subagentFolder, { recursive: true });
    writeFileSync(path, "");
    writeFileSync(
      path.slice(0, -TRANSCRIPT_EXTENSION.length) + SUBAGENT_METADATA_EXTENSION,
      JSON.stringify({ toolUseId, agentType }),
    );
    outputs.set(agentId, { path, lines: lines.map(renamed) });
  }
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

  const written = new Map<string | undefined, number>();
  let finishedTurns = 0;
  let lastToolStart = 0;
  for (const event of plan.events) {
    const output = outputs.get(event.agentId);
    if (output === undefined) throw new Error(`no transcript for subagent ${event.agentId}`);
    const done = written.get(event.agentId) ?? 0;
    appendFileSync(
      output.path,
      output.lines
        .slice(done, event.transcriptLines)
        .map((line) => `${line}\n`)
        .join(""),
    );
    written.set(event.agentId, Math.max(done, event.transcriptLines));
    if (event.payload.hook_event_name === turnEvents.prompt && options.turnGapMs > 0)
      await sleep(options.turnGapMs);
    if (event.payload.hook_event_name === turnEvents.toolStart && options.toolGapMs > 0) {
      await sleep(Math.max(0, lastToolStart + options.toolGapMs - Date.now()));
      lastToolStart = Date.now();
    }
    const payload = renamed(
      JSON.stringify({
        ...event.payload,
        transcript_path: transcript,
        cwd: project,
        ...(event.agentId === undefined ? {} : { agent_transcript_path: output.path }),
      }),
    );
    for (const command of commands.get(String(event.payload.hook_event_name)) ?? []) {
      const measured = usageGroup === undefined ? command : commandInGroup(usageGroup, command);
      const exitCode = await runHookCommand(measured, payload, project, env);
      if (exitCode !== 0)
        console.warn(`${event.payload.hook_event_name} hook exited with ${exitCode}`);
    }
    if (event.payload.hook_event_name === turnEvents.stop)
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
    "tool-gap-ms": { type: "string", default: "0" },
    "turn-gap-ms": { type: "string", default: "0" },
    parallel: { type: "string", default: "1" },
    "fresh-session-id": { type: "boolean", default: false },
  },
});
const agent = values.agent;
if (process.platform !== "linux") console.warn(BUNDLED_BINARY_WARNING);
if (agent !== "claude" && agent !== "codex" && agent !== "cursor")
  throw new Error("--agent must be claude, codex or cursor");
if (!values.plugin || !values.sessions?.length)
  throw new Error("--plugin and --sessions are required");
const options: ReplayOptions = {
  agent,
  pluginDir: resolve(values.plugin),
  profileDir: values["profile-dir"] === undefined ? undefined : resolve(values["profile-dir"]),
  toolGapMs: gapOption("tool-gap-ms", values["tool-gap-ms"]),
  turnGapMs: gapOption("turn-gap-ms", values["turn-gap-ms"]),
  freshSessionId: values["fresh-session-id"],
};
const parallel = Number(values.parallel);
if (!Number.isInteger(parallel) || parallel < 1)
  throw new Error("--parallel must be a whole number of at least 1");

let failed = 0;
let replayed = 0;
const usages: EngineUsage[] = [];
const files = values.sessions.flatMap((sessions) => transcriptFiles(resolve(sessions)));
await forEachInParallel(files, parallel, async (file, index) => {
  const rawLines = readTranscript(file);
  const plan = planners[agent](
    rawLines.map((line) => JSON.parse(line) as TranscriptLine),
    subagentReader(file),
    basename(file, TRANSCRIPT_EXTENSION),
  );
  const reason = skipReason(plan, TURN_EVENTS[agent]);
  if (reason !== undefined) {
    console.log(`SKIP ${basename(file)} (${reason})`);
    return;
  }
  const usageGroup =
    values.cgroup === undefined ? undefined : createUsageGroup(values.cgroup, `session-${index}`);
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
});
if (usages.length > 0) console.log(`percentiles ${usageSummary(usages)}`);
console.log(`${failed} of ${replayed} replayed sessions failed`);
if (failed > 0 || replayed === 0) process.exit(1);
