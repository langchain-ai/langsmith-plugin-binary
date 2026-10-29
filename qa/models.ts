export type AgentName = "claude" | "codex";

export interface ScenarioTurn {
  prompt: string;
  command: string;
  minTools: number;
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

export interface FakeServer {
  url: string;
  runs: () => TracedRun[];
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
