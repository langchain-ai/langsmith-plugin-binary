import {
  CLAUDE_LOCAL_OUTPUT_PREFIX,
  CLAUDE_NON_PROMPT_PREFIX,
  CLAUDE_SHELL_PROMPT,
  CLAUDE_SYSTEM_REMINDER,
  DEFAULT_SUBAGENT_TYPE,
  PRE_TOOL_EVENT,
  REPLAY_PERMISSION_MODE,
  SESSION_END,
  SESSION_START,
  SKILL_TOOL_NAME,
  SUBAGENT_BACKGROUND_STATUS,
  SUBAGENT_STOP_EVENT,
} from "../constants.ts";
import type {
  PlacedSubagent,
  ReplayEvent,
  ReplayPlan,
  ScenarioTurn,
  SubagentLaunch,
  SubagentReader,
  TimedReplayEvent,
  TranscriptLine,
} from "../models.ts";
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

function preToolUse(use: TranscriptLine): Record<string, unknown> {
  return {
    hook_event_name: PRE_TOOL_EVENT,
    tool_name: use.name,
    tool_input: use.input,
    tool_use_id: use.id,
  };
}

function postToolUse(
  line: TranscriptLine,
  result: TranscriptLine,
  use: TranscriptLine | undefined,
): Record<string, unknown> {
  return {
    hook_event_name: result.is_error ? "PostToolUseFailure" : "PostToolUse",
    tool_name: use?.name ?? "unknown",
    tool_input: use?.input ?? {},
    tool_use_id: result.tool_use_id,
    tool_response: line.toolUseResult ?? result.content,
  };
}

function timeOf(line: TranscriptLine | undefined): number {
  return Date.parse(String(line?.timestamp));
}

function subagentEvents(sessionId: string, launch: SubagentLaunch): TimedReplayEvent[] {
  const lines = launch.lines.map((line) => JSON.parse(line) as TranscriptLine);
  const toolUses = new Map<string, TranscriptLine>();
  const events: TimedReplayEvent[] = [];
  let lastText = "";
  let at = Number.NaN;
  const emit = (transcriptLines: number, fields: Record<string, unknown>) => {
    events.push({
      at,
      event: {
        agentId: launch.agentId,
        transcriptLines,
        payload: {
          session_id: sessionId,
          permission_mode: REPLAY_PERMISSION_MODE,
          agent_id: launch.agentId,
          agent_type: launch.agentType,
          ...fields,
        },
      },
    });
  };
  for (const [index, line] of lines.entries()) {
    at = timeOf(line);
    if (line.type === "assistant") {
      for (const text of blocks(line, "text")) lastText = String(text.text);
      for (const use of blocks(line, "tool_use")) {
        toolUses.set(use.id, use);
        emit(index + 1, preToolUse(use));
      }
    }
    for (const result of line.type === "user" ? blocks(line, "tool_result") : []) {
      emit(index + 1, postToolUse(line, result, toolUses.get(result.tool_use_id)));
    }
  }
  emit(lines.length, {
    hook_event_name: SUBAGENT_STOP_EVENT,
    stop_hook_active: false,
    last_assistant_message: lastText,
  });
  return events;
}

function slotFor(at: number, times: number[], subagent: PlacedSubagent): number {
  const first = subagent.background ? subagent.postToolUseIndex + 1 : 0;
  const last = subagent.background ? times.length : subagent.postToolUseIndex;
  const later = times.findIndex((time, index) => index >= first && time > at);
  return Math.min(Math.max(later === -1 ? times.length : later, first), last);
}

function withSubagents(
  events: ReplayEvent[],
  times: number[],
  subagents: PlacedSubagent[],
): ReplayEvent[] {
  const slotted = subagents
    .flatMap((subagent) =>
      subagent.events.map((timed) => ({ ...timed, slot: slotFor(timed.at, times, subagent) })),
    )
    .toSorted((left, right) => left.slot - right.slot || left.at - right.at);
  return events.flatMap((event, index) => [
    ...slotted.filter(({ slot }) => slot === index).map((timed) => timed.event),
    event,
    ...(index === events.length - 1
      ? slotted.filter(({ slot }) => slot === events.length).map((timed) => timed.event)
      : []),
  ]);
}

export function claudePlan(
  lines: TranscriptLine[],
  readSubagent: SubagentReader = () => undefined,
): ReplayPlan {
  const sessionId = String(lines.find((line) => line.sessionId)?.sessionId ?? "");
  const toolUses = new Map<string, TranscriptLine>();
  const events: ReplayEvent[] = [];
  const times: number[] = [];
  const turns: ScenarioTurn[] = [];
  const subagents: SubagentLaunch[] = [];
  const placed: PlacedSubagent[] = [];
  let current: ScenarioTurn | undefined;
  let lastText = "";
  let at = Number.NaN;

  const emit = (transcriptLines: number, fields: Record<string, unknown>) => {
    times.push(at);
    events.push({
      transcriptLines,
      payload: {
        session_id: sessionId,
        permission_mode: REPLAY_PERMISSION_MODE,
        ...fields,
      },
    });
  };

  for (const [index, line] of lines.entries()) {
    at = timeOf(line);
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
      lastText = "";
      emit(index, { hook_event_name: "UserPromptSubmit", prompt: current.prompt });
    }
    if (line.type === "assistant" && !line.isSidechain) {
      if (current !== undefined) current.expectsModelCall = true;
      for (const text of blocks(line, "text")) lastText = String(text.text);
      for (const use of blocks(line, "tool_use")) {
        toolUses.set(use.id, use);
        emit(index + 1, preToolUse(use));
      }
    }
    for (const result of line.type === "user" ? blocks(line, "tool_result") : []) {
      const use = toolUses.get(result.tool_use_id);
      if (current !== undefined && use !== undefined && use.name !== SKILL_TOOL_NAME) {
        current.minTools += 1;
        current.maxTools = current.minTools;
      }
      const agentId = line.toolUseResult?.agentId;
      const subagentLines = agentId === undefined ? undefined : readSubagent(String(agentId));
      if (subagentLines !== undefined) {
        const launch = {
          agentId: String(agentId),
          toolUseId: String(result.tool_use_id),
          agentType: String(use?.input?.subagent_type ?? DEFAULT_SUBAGENT_TYPE),
          lines: subagentLines,
        };
        const timed = subagentEvents(sessionId, launch);
        const subagentTools = timed.filter(
          ({ event }) =>
            event.payload.hook_event_name !== PRE_TOOL_EVENT &&
            event.payload.hook_event_name !== SUBAGENT_STOP_EVENT &&
            event.payload.tool_name !== SKILL_TOOL_NAME,
        ).length;
        if (current !== undefined) {
          current.minTools += subagentTools;
          current.maxTools = current.minTools;
        }
        subagents.push(launch);
        placed.push({
          events: timed,
          postToolUseIndex: events.length,
          background: line.toolUseResult?.status === SUBAGENT_BACKGROUND_STATUS,
        });
      }
      emit(index + 1, postToolUse(line, result, use));
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
  const replayed = withSubagents(events, times, placed);
  replayed.unshift({ transcriptLines: 0, payload: { ...events[0]?.payload, ...SESSION_START } });
  replayed.push({
    transcriptLines: lines.length,
    payload: { ...events.at(-1)?.payload, ...SESSION_END },
  });
  return { sessionId, events: replayed, turns, subagents };
}
