import type { Endpoints, TypingPace } from "./models.ts";

export const DEV_ENDPOINT = "https://dev.api.smith.langchain.com";
export const GATEWAY_URL = "https://gateway.smith.langchain.com";
export const LIVE_ENDPOINTS: Endpoints = {
  tracing: DEV_ENDPOINT,
  anthropic: `${GATEWAY_URL}/anthropic/`,
  openai: `${GATEWAY_URL}/v1`,
};

export const CLAUDE_MODEL = "claude-haiku-4-5";
export const CODEX_MODEL = "openai/gpt-5.4-mini";
export const CLAUDE_ALLOWED_TOOLS = "Bash Read";
export const GATEWAY_KEY_ENV = "LC_GATEWAY_KEY";
export const EXIT_COMMAND = "/exit";

export const CLAUDE_TYPING: TypingPace = { keyDelayMs: 10, enterDelayMs: 300 };
export const CODEX_TYPING: TypingPace = { keyDelayMs: 40, enterDelayMs: 1_500 };

export const TERMINAL_COLUMNS = 120;
export const TERMINAL_ROWS = 40;
export const STARTUP_WAIT_MS = 8_000;
export const HOOK_RETRY_WAIT_MS = 15_000;
export const HOOK_RETRY_ATTEMPTS = 3;
export const TURN_TIMEOUT_MS = 180_000;
export const EXIT_WAIT_MS = 8_000;
export const SCREEN_TAIL_CHARS = 600;

export const UPLOAD_TIMEOUT_MS = 120_000;
export const UPLOAD_POLL_MS = 5_000;
export const UPLOAD_QUIET_MS = 3_000;
export const RUN_QUERY_LIMIT = 100;

export const STOP_EVENT = "Stop";
export const PROMPT_EVENT = "UserPromptSubmit";
export const SKILL_TOOL_NAME = "Skill";
export const RECORDED_EVENTS = ["UserPromptSubmit", "Stop"];

export const FAKE_CALL_ID_PREFIX = "toolu_qa_";
export const FAKE_API_KEY = "fake-key";
export const FAKE_IDLE_REPLY = "Ready.";
export const FAKE_MESSAGE_ID = "msg_qa";
export const FAKE_RESPONSE_ID = "resp_qa";
export const FAKE_FUNCTION_CALL_ID_PREFIX = "fc_";
export const FAKE_ANTHROPIC_USAGE = { input_tokens: 10, output_tokens: 5 };
export const FAKE_OPENAI_USAGE = {
  input_tokens: 10,
  input_tokens_details: null,
  output_tokens: 5,
  output_tokens_details: null,
  total_tokens: 15,
};
export const BUNDLED_BINARY_WARNING =
  "warning: off Linux the plugins run their committed binary, so this tests the released engine rather than this checkout";
export const FAKE_SERVER_INFO = {
  version: "0.0.0",
  batch_ingest_config: { use_multipart_endpoint: false },
};

export const CLAUDE_NON_PROMPT_PREFIX =
  /^\s*(<local-command|<bash-stdout|<bash-stderr|\[Request interrupted by user)/;
export const CLAUDE_SHELL_PROMPT = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/;
export const CLAUDE_SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
export const CLAUDE_LOCAL_OUTPUT_PREFIX = /^\s*<local-command-stdout>/;
export const HOOK_TIMEOUT_MS = 60_000;
export const SESSION_START = { hook_event_name: "SessionStart", source: "startup" };
export const SESSION_END = { hook_event_name: "SessionEnd", reason: "prompt_input_exit" };
export const TURN_SETTLE_TIMEOUT_MS = 15_000;
export const TURN_SETTLE_POLL_MS = 250;
export const PROMPT_MATCH_CHARS = 80;
export const CODEX_TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
export const CODEX_TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
export const CODEX_MODEL_OUTPUT_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "custom_tool_call",
]);
export const CODEX_INJECTED_FRAGMENTS: readonly RegExp[] = [
  /^<(environment_context|skill|turn_aborted|subagent_notification|agent_message_board_notification|recommended_plugins|goal_context|codex_internal_context|external_[^\s>]+)[\s>][\s\S]*<\/\1>$/i,
  /^# AGENTS\.md instructions[\s\S]*<\/INSTRUCTIONS>$/i,
  /^<\/?image(?:\s[^>]*)?>$/i,
];
export const CODEX_SHELL_COMMAND = /^\s*<user_shell_command>\s*<command>([\s\S]*?)<\/command>/;
export const CGROUP_PROCESSES_FILE = "cgroup.procs";
export const CGROUP_EVENTS_FILE = "cgroup.events";
export const CGROUP_KILL_FILE = "cgroup.kill";
export const CGROUP_CPU_FILE = "cpu.stat";
export const CGROUP_MEMORY_PEAK_FILE = "memory.peak";
export const CGROUP_POPULATED = /^populated 1$/m;
export const CGROUP_CPU_USAGE = /^usage_usec (\d+)$/m;
export const ENGINE_EXIT_TIMEOUT_MS = 15_000;
export const ENGINE_EXIT_POLL_MS = 250;
export const BYTES_PER_MEGABYTE = 1024 * 1024;
export const USAGE_PERCENTILES = [50, 95, 99];
export const USAGE_LINE = /^usage .+: (\d+) ms CPU, ([\d.]+) MB peak memory$/gm;
