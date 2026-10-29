import type { TypingPace } from "./models.ts";

export const DEV_ENDPOINT = "https://dev.api.smith.langchain.com";
export const GATEWAY_URL = "https://gateway.smith.langchain.com";

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
export const RUN_QUERY_LIMIT = 100;

export const STOP_EVENT = "Stop";
export const RECORDED_EVENTS = ["UserPromptSubmit", "Stop"];
