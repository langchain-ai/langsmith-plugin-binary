import {
  CLAUDE_LOCAL_OUTPUT_PREFIX,
  CLAUDE_NON_PROMPT_PREFIX,
  CLAUDE_SHELL_PROMPT,
  CLAUDE_SYSTEM_REMINDER,
  SESSION_END,
  SESSION_START,
} from "../constants.ts";
import type { ReplayEvent, ReplayPlan, ScenarioTurn, TranscriptLine } from "../models.ts";
import { textOf } from "../utils/text.ts";

function blocks(line: TranscriptLine, type: string): TranscriptLine[] {
  const content = line.message?.content;
  return Array.isArray(content) ? content.filter((block) => block?.type === type) : [];
}

function isUserText(line: TranscriptLine | undefined): line is TranscriptLine {
  if (line?.type !== "user" || line.isMeta || line.isCompactSummary || line.isSidechain)
    return false;
  return blocks(line, "tool_result").length === 0;
}

function isPrompt(lines: TranscriptLine[], index: number): boolean {
  const line = lines[index];
  if (!isUserText(line) || CLAUDE_NON_PROMPT_PREFIX.test(textOf(line.message?.content)))
    return false;
  const reply = lines.slice(index + 1).find(isUserText);
  return !CLAUDE_LOCAL_OUTPUT_PREFIX.test(textOf(reply?.message?.content));
}

function promptText(line: TranscriptLine): string {
  const text = textOf(line.message?.content).replace(CLAUDE_SYSTEM_REMINDER, "").trim();
  return CLAUDE_SHELL_PROMPT.exec(text)?.[1] ?? text;
}

function endsTurn(lines: TranscriptLine[], index: number): boolean {
  const line = lines[index];
  if (line?.type !== "assistant" || line.isSidechain || line.message?.stop_reason !== "end_turn")
    return false;
  const next = lines
    .slice(index + 1)
    .find((later) => later.type === "assistant" || isUserText(later));
  return next === undefined || next.message?.id !== line.message?.id;
}

export function claudePlan(lines: TranscriptLine[]): ReplayPlan {
  const sessionId = String(lines.find((line) => line.sessionId)?.sessionId ?? "");
  const toolUses = new Map<string, TranscriptLine>();
  const events: ReplayEvent[] = [];
  const turns: ScenarioTurn[] = [];
  let current: ScenarioTurn | undefined;
  let lastText = "";

  const emit = (transcriptLines: number, fields: Record<string, unknown>) => {
    events.push({
      transcriptLines,
      payload: {
        session_id: sessionId,
        permission_mode: "default",
        ...fields,
      },
    });
  };

  for (const [index, line] of lines.entries()) {
    if (line.type === "system" && line.subtype === "compact_boundary") {
      emit(index, {
        hook_event_name: "PreCompact",
        trigger: line.compactMetadata?.trigger ?? "auto",
      });
    }
    if (line.type === "user" && line.isCompactSummary) {
      emit(index + 1, {
        hook_event_name: "PostCompact",
        trigger: "auto",
        compact_summary: textOf(line.message?.content),
      });
    }
    if (isPrompt(lines, index)) {
      current = {
        prompt: promptText(line),
        command: "",
        minTools: 0,
        maxTools: 0,
        reply: null,
        expectsModelCall: false,
      };
      turns.push(current);
      emit(index, { hook_event_name: "UserPromptSubmit", prompt: current.prompt });
    }
    if (line.type === "assistant" && !line.isSidechain) {
      if (current !== undefined) current.expectsModelCall = true;
      for (const text of blocks(line, "text")) lastText = String(text.text);
      for (const use of blocks(line, "tool_use")) {
        toolUses.set(use.id, use);
        emit(index + 1, {
          hook_event_name: "PreToolUse",
          tool_name: use.name,
          tool_input: use.input,
          tool_use_id: use.id,
        });
      }
    }
    for (const result of line.type === "user" ? blocks(line, "tool_result") : []) {
      const use = toolUses.get(result.tool_use_id);
      if (current !== undefined && use !== undefined) {
        current.minTools += 1;
        current.maxTools = current.minTools;
      }
      emit(index + 1, {
        hook_event_name: result.is_error ? "PostToolUseFailure" : "PostToolUse",
        tool_name: use?.name ?? "unknown",
        tool_input: use?.input ?? {},
        tool_use_id: result.tool_use_id,
        tool_response: line.toolUseResult ?? result.content,
      });
    }
    if (endsTurn(lines, index) && current !== undefined) {
      if (lastText.length > 0) current.reply = lastText;
      emit(index + 1, {
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: lastText,
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
