import {
  CURSOR_ABORTED_STATUS,
  CURSOR_COMPOSER_MODE,
  CURSOR_ERROR_STATUS,
  CURSOR_PROMPT_EVENT,
  CURSOR_REPLAY_MODEL,
  CURSOR_STOP_EVENT,
  CURSOR_STOP_STATUS,
  CURSOR_TOOL_EVENT,
  CURSOR_TURN_ENDED,
  CURSOR_USER_QUERY,
} from "../constants.ts";
import type {
  ReplayEvent,
  ReplayPlan,
  ScenarioTurn,
  SubagentReader,
  TranscriptLine,
} from "../models.ts";
import { textOf } from "../utils/text.ts";

function promptText(line: TranscriptLine): string {
  const text = textOf(line.message?.content);
  return (CURSOR_USER_QUERY.exec(text)?.[2] ?? text).trim();
}

export function cursorPlan(
  lines: TranscriptLine[],
  _readSubagent: SubagentReader,
  sessionName: string,
): ReplayPlan {
  const events: ReplayEvent[] = [];
  const turns: ScenarioTurn[] = [];
  let current: ScenarioTurn | undefined;
  let generationId = "";
  let toolCount = 0;
  let lastText = "";

  const emit = (transcriptLines: number, fields: Record<string, unknown>) => {
    events.push({
      transcriptLines,
      payload: {
        conversation_id: sessionName,
        session_id: sessionName,
        generation_id: generationId,
        model: CURSOR_REPLAY_MODEL,
        ...fields,
      },
    });
  };
  const stop = (transcriptLines: number, status: string) => {
    emit(transcriptLines, { hook_event_name: CURSOR_STOP_EVENT, status, loop_count: 0 });
    current = undefined;
  };

  emit(0, {
    hook_event_name: "sessionStart",
    is_background_agent: false,
    composer_mode: CURSOR_COMPOSER_MODE,
  });
  for (const [index, line] of lines.entries()) {
    if (line.role === "user") {
      if (current !== undefined) stop(index, CURSOR_ABORTED_STATUS);
      generationId = `${sessionName}-${turns.length + 1}`;
      toolCount = 0;
      lastText = "";
      current = {
        prompt: promptText(line),
        command: "",
        minTools: 0,
        maxTools: 0,
        reply: null,
        expectsModelCall: false,
      };
      turns.push(current);
      emit(index, {
        hook_event_name: CURSOR_PROMPT_EVENT,
        prompt: current.prompt,
        attachments: [],
        composer_mode: CURSOR_COMPOSER_MODE,
      });
    }
    if (line.role === "assistant" && current !== undefined) {
      current.expectsModelCall = true;
      for (const block of line.message?.content ?? []) {
        if (block?.type === "text") lastText = String(block.text);
        if (block?.type !== "tool_use") continue;
        toolCount += 1;
        current.minTools = toolCount;
        current.maxTools = toolCount;
        emit(index + 1, {
          hook_event_name: CURSOR_TOOL_EVENT,
          tool_name: block.name,
          tool_input: block.input ?? {},
          tool_output: JSON.stringify({}),
          tool_use_id: `${generationId}-tool-${toolCount}`,
        });
      }
    }
    if (line.type === CURSOR_TURN_ENDED && current !== undefined) {
      if (lastText.length > 0) {
        current.reply = lastText;
        emit(index, { hook_event_name: "afterAgentResponse", text: lastText });
      }
      stop(index + 1, CURSOR_STOP_STATUS[line.status] ?? CURSOR_ERROR_STATUS);
    }
  }
  return { sessionId: sessionName, events, turns, subagents: [] };
}
