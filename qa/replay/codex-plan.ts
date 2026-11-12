import {
  CODEX_INJECTED_FRAGMENTS,
  CODEX_SHELL_COMMAND,
  CODEX_MODEL_OUTPUT_TYPES,
  CODEX_TOOL_CALL_TYPES,
  CODEX_TOOL_OUTPUT_TYPES,
  SESSION_END,
  SESSION_START,
} from "../constants.ts";
import type { ReplayEvent, ReplayPlan, ScenarioTurn, TranscriptLine } from "../models.ts";
import { textBlocksOf } from "../utils/text.ts";

function isUserMessageEvent(line: TranscriptLine): boolean {
  return line.type === "event_msg" && line.payload?.type === "user_message";
}

function promptOf(line: TranscriptLine, promptsFromEvents: boolean): string | undefined {
  if (promptsFromEvents) return isUserMessageEvent(line) ? String(line.payload.message) : undefined;
  const payload = line.payload ?? {};
  if (line.type !== "response_item" || payload.type !== "message" || payload.role !== "user")
    return undefined;
  const text = textBlocksOf(payload.content)
    .filter((block) => !CODEX_INJECTED_FRAGMENTS.some((pattern) => pattern.test(block.trim())))
    .join("\n")
    .trim();
  const shellCommand = CODEX_SHELL_COMMAND.exec(text)?.[1];
  if (shellCommand !== undefined) return shellCommand.trim();
  return text.length > 0 ? text : undefined;
}

function toolInput(call: TranscriptLine | undefined): unknown {
  if (call === undefined) return {};
  if (typeof call.arguments !== "string") return call.input ?? {};
  try {
    return JSON.parse(call.arguments);
  } catch {
    return call.arguments;
  }
}

export function codexPlan(lines: TranscriptLine[]): ReplayPlan {
  const meta = lines.find((line) => line.type === "session_meta")?.payload ?? {};
  const sessionId = String(meta.session_id ?? meta.id ?? "");
  if (typeof meta.source === "object" && meta.source?.subagent)
    return { sessionId, events: [], turns: [] };
  const promptsFromEvents = lines.some(isUserMessageEvent);
  const calls = new Map<string, TranscriptLine>();
  const events: ReplayEvent[] = [];
  const turns: ScenarioTurn[] = [];
  let model = "";
  let turnId = "";
  let current: ScenarioTurn | undefined;

  const emit = (index: number, fields: Record<string, unknown>) => {
    events.push({
      transcriptLines: index + 1,
      payload: {
        session_id: sessionId,
        turn_id: turnId,
        model,
        permission_mode: "default",
        ...fields,
      },
    });
  };

  for (const [index, line] of lines.entries()) {
    const payload = line.payload ?? {};
    if (line.type === "turn_context" && payload.model) model = String(payload.model);
    if (line.type === "event_msg" && payload.type === "task_started") {
      turnId = String(payload.turn_id ?? payload.turn_attribution?.turn_id ?? "");
      current = undefined;
    }
    const prompt = promptOf(line, promptsFromEvents);
    if (prompt !== undefined && current === undefined) {
      current = {
        prompt,
        command: "",
        minTools: 0,
        maxTools: 0,
        reply: null,
        expectsModelCall: false,
      };
      turns.push(current);
      emit(index, { hook_event_name: "UserPromptSubmit", prompt: current.prompt });
    }
    const fromModel =
      CODEX_MODEL_OUTPUT_TYPES.has(payload.type) &&
      (payload.type !== "message" || payload.role === "assistant");
    if (line.type === "response_item" && current !== undefined && fromModel)
      current.expectsModelCall = true;
    if (line.type === "response_item" && CODEX_TOOL_CALL_TYPES.has(payload.type))
      calls.set(payload.call_id, payload);
    if (
      line.type === "response_item" &&
      CODEX_TOOL_OUTPUT_TYPES.has(payload.type) &&
      current !== undefined
    ) {
      const call = calls.get(payload.call_id);
      current.minTools += 1;
      current.maxTools = current.minTools;
      emit(index, {
        hook_event_name: "PostToolUse",
        tool_name: call?.name ?? "unknown",
        tool_input: toolInput(call),
        tool_response: payload.output,
        tool_use_id: payload.call_id,
      });
    }
    if (line.type === "event_msg" && payload.type === "task_complete" && current !== undefined) {
      const reply = payload.last_agent_message;
      if (typeof reply === "string" && reply.length > 0) current.reply = reply;
      emit(index, {
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: reply ?? "",
      });
      current = undefined;
    }
  }
  events.unshift({ transcriptLines: 0, payload: { ...events[0]?.payload, ...SESSION_START } });
  events.push({
    transcriptLines: lines.length,
    payload: { ...events.at(-1)?.payload, ...SESSION_END },
  });
  return { sessionId, events, turns };
}
