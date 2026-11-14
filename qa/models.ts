export type AgentName = "claude" | "codex";
export type ReplayAgentName = AgentName | "cursor";

export interface ScenarioTurn {
  prompt: string;
  command: string;
  minTools: number;
  maxTools?: number;
  reply?: string | null;
  expectsModelCall?: boolean;
  toolOutputContains?: string;
}

export interface Scenario {
  name: string;
  files: Record<string, string>;
  turns: ScenarioTurn[];
  hooksPerTurn: Record<AgentName, string[]>;
}

export interface RunOptions {
  agent: AgentName;
  pluginDir: string;
  scenario: Scenario;
  project: string;
  workDir: string;
  tracingApiKey: string;
  gatewayApiKey: string;
  agentCommand: string;
  endpoints: Endpoints;
}

export type TracingSettings = Pick<
  RunOptions,
  "pluginDir" | "project" | "tracingApiKey" | "endpoints"
>;

export interface Endpoints {
  tracing: string;
  anthropic: string;
  openai: string;
}

export interface AgentLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  typing: TypingPace;
  exitCommand: string;
}

export interface TracedRun {
  id: string;
  name: string;
  run_type: string;
  trace_id: string;
  parent_run_id: string | null;
  start_time: string;
  end_time: string | null;
  inputs: unknown;
  outputs: unknown;
}

export interface RootOutputs {
  messages?: unknown;
  text?: unknown;
}

export interface Workspace {
  home: string;
  project: string;
  eventsFile: string;
}

export interface PreparedAgent {
  launch: AgentLaunch;
  headlessArgs: (prompt: string, turnIndex: number) => string[];
  eventsFile: string;
  secretFiles: string[];
}

export type FakeStep =
  | { kind: "tool"; callId: string; command: string }
  | { kind: "reply"; text: string };

export interface TurnResult {
  exitCode: number | null;
  outputTail: string;
}

export interface FakeServer {
  url: string;
  runs: () => TracedRun[];
  batchesReceived: () => number;
  close: () => Promise<void>;
}

export interface HookCommand {
  command: string;
  [setting: string]: unknown;
}

export interface HookGroup {
  hooks: HookCommand[];
  [setting: string]: unknown;
}

export interface HooksFile {
  hooks: Record<string, HookGroup[]>;
}

export interface PluginHookEntry {
  command?: string;
  hooks?: HookCommand[];
}

export interface PluginHooksFile {
  hooks: Record<string, PluginHookEntry[]>;
}

export interface TypingPace {
  keyDelayMs: number;
  enterDelayMs: number;
}

export interface RunPayload {
  id: string;
  [field: string]: unknown;
}

export interface RunBatch {
  post?: RunPayload[];
  patch?: RunPayload[];
}

export interface AnthropicContentBlock {
  start: unknown;
  delta: unknown;
}

export type TranscriptLine = Record<string, any>;

export interface TextBlock {
  type: string;
  text: string;
}

export type SubagentReader = (agentId: string) => string[] | undefined;
export type ReplayPlanner = (
  lines: TranscriptLine[],
  readSubagent: SubagentReader,
  sessionName: string,
) => ReplayPlan;
export type TracingEnvironment = (settings: TracingSettings) => Record<string, string>;

export interface ReplayEvent {
  payload: Record<string, unknown>;
  transcriptLines: number;
  agentId?: string;
}

export interface SubagentLaunch {
  agentId: string;
  toolUseId: string;
  agentType: string;
  lines: string[];
}

export interface TimedReplayEvent {
  event: ReplayEvent;
  at: number;
}

export interface PlacedSubagent {
  events: TimedReplayEvent[];
  postToolUseIndex: number;
  background: boolean;
}

export interface ReplayPlan {
  sessionId: string;
  events: ReplayEvent[];
  turns: ScenarioTurn[];
  subagents: SubagentLaunch[];
}

export interface ReplayOptions {
  agent: ReplayAgentName;
  pluginDir: string;
  profileDir: string | undefined;
  toolGapMs: number;
  turnGapMs: number;
  freshSessionId: boolean;
}

export interface ReplayTranscript {
  path: string;
  lines: string[];
}

export interface EngineUsage {
  cpuMs: number;
  peakMemoryBytes: number;
  exitedOnItsOwn: boolean;
}

export interface TurnEvents {
  prompt: string;
  stop: string;
  toolStart: string;
}
