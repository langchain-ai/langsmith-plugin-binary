import { SESSION_END, SESSION_START } from "../constants.ts";
import type { ReplayEvent, ReplayPlan, ScenarioTurn, TranscriptLine } from "../models.ts";

const toolCallTypes = new Set(["function_call", "custom_tool_call"]);
const toolOutputTypes = new Set(["function_call_output", "custom_tool_call_output"]);
const modelOutputTypes = new Set(["message", "reasoning", "function_call", "custom_tool_call"]);

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
  const sessionId = String(meta.session_id ?? meta.id);
  if (typeof meta.source === "object" && meta.source?.subagent)
    return { sessionId, events: [], turns: [] };
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
    if (line.type === "event_msg" && payload.type === "user_message" && current === undefined) {
      current = {
        prompt: String(payload.message),
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
      modelOutputTypes.has(payload.type) &&
      (payload.type !== "message" || payload.role === "assistant");
    if (line.type === "response_item" && current !== undefined && fromModel)
      current.expectsModelCall = true;
    if (line.type === "response_item" && toolCallTypes.has(payload.type))
      calls.set(payload.call_id, payload);
    if (
      line.type === "response_item" &&
      toolOutputTypes.has(payload.type) &&
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
