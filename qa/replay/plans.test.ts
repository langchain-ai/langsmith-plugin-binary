import { describe, expect, it } from "vitest";
import { claudePlan } from "./claude-plan.ts";
import { codexPlan } from "./codex-plan.ts";
import { cursorPlan } from "./cursor-plan.ts";

const claudeTranscript = [
  { type: "user", sessionId: "s1", message: { role: "user", content: "list files" } },
  {
    type: "assistant",
    message: {
      id: "m1",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
  },
  {
    type: "assistant",
    message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "One file." }] },
  },
  { type: "user", message: { content: "<command-name>/clear</command-name>" } },
  { type: "user", message: { content: "<local-command-stdout></local-command-stdout>" } },
  { type: "user", message: { content: "<system-reminder>\nnote\n</system-reminder>\nthanks" } },
  {
    type: "assistant",
    message: { id: "m3", stop_reason: "end_turn", content: [{ type: "text", text: "Sure." }] },
  },
  { type: "user", message: { content: "<bash-input>ls</bash-input>" } },
];

const codexRollout = [
  { type: "session_meta", payload: { session_id: "c1", source: "cli" } },
  { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
  { type: "event_msg", payload: { type: "user_message", message: "list files" } },
  {
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "k1",
      name: "exec_command",
      arguments: '{"cmd":"ls"}',
    },
  },
  {
    type: "response_item",
    payload: { type: "function_call_output", call_id: "k1", output: "a.txt" },
  },
  {
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "One file." },
  },
];

const cursorTranscript = [
  {
    role: "user",
    message: {
      content: [
        {
          type: "text",
          text: "<timestamp>Today</timestamp>\n<user_query>\nlist files\n</user_query>",
        },
      ],
    },
  },
  {
    role: "assistant",
    message: {
      content: [
        { type: "text", text: "Looking." },
        { type: "tool_use", name: "Shell", input: { command: "ls" } },
      ],
    },
  },
  { role: "assistant", message: { content: [{ type: "text", text: "One file." }] } },
  { type: "turn_ended", status: "success" },
];

function noSubagents(): undefined {
  return undefined;
}

function at(seconds: number): string {
  return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
}

function codexUserMessage(...texts: string[]) {
  const content = texts.map((text) => ({ type: "input_text", text }));
  return { type: "response_item", payload: { type: "message", role: "user", content } };
}

describe("claudePlan", () => {
  it("expects one turn per real prompt with its tools and reply", () => {
    expect(claudePlan(claudeTranscript).turns).toEqual([
      {
        prompt: "list files",
        command: "",
        minTools: 1,
        maxTools: 1,
        reply: "One file.",
        expectsModelCall: true,
      },
      {
        prompt: "thanks",
        command: "",
        minTools: 0,
        maxTools: 0,
        reply: "Sure.",
        expectsModelCall: true,
      },
      { prompt: "ls", command: "", minTools: 0, maxTools: 0, reply: null, expectsModelCall: false },
    ]);
  });

  it("fires the prompt hook before the prompt reaches the transcript", () => {
    const prompt = claudePlan(claudeTranscript).events.find(
      (event) => event.payload.hook_event_name === "UserPromptSubmit",
    );
    expect(prompt?.transcriptLines).toBe(0);
  });

  it("does not carry a reply over from the previous turn", () => {
    const interrupted = [
      ...claudeTranscript.slice(0, 4),
      { type: "user", message: { content: "and again" } },
      {
        type: "assistant",
        message: { id: "m4", stop_reason: "end_turn", content: [] },
      },
    ];
    const stops = claudePlan(interrupted).events.filter(
      (event) => event.payload.hook_event_name === "Stop",
    );
    expect(stops.map((event) => event.payload.last_assistant_message)).toEqual(["One file.", ""]);
  });

  it("ignores subagent lines when reading the main thread", () => {
    const withSubagent = [
      claudeTranscript[0]!,
      { type: "user", isSidechain: true, message: { content: "subagent prompt" } },
      {
        type: "assistant",
        isSidechain: true,
        message: { id: "s1", stop_reason: "end_turn", content: [{ type: "text", text: "Sub." }] },
      },
      claudeTranscript[3]!,
    ];
    expect(claudePlan(withSubagent).turns.map((turn) => [turn.prompt, turn.reply])).toEqual([
      ["list files", "One file."],
    ]);
  });

  it("ends the turn only after the last line of a split message", () => {
    const split = [
      claudeTranscript[0]!,
      {
        type: "assistant",
        message: {
          id: "m2",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Part one." }],
        },
      },
      {
        type: "assistant",
        message: {
          id: "m2",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Part two." }],
        },
      },
    ];
    const stops = claudePlan(split).events.filter(
      (event) => event.payload.hook_event_name === "Stop",
    );
    expect(
      stops.map((event) => [event.transcriptLines, event.payload.last_assistant_message]),
    ).toEqual([[3, "Part two."]]);
  });

  it("expects a turn for a message from another session but not for other meta lines", () => {
    const peer = [
      { type: "user", isMeta: true, message: { content: "skill instructions" } },
      {
        type: "user",
        isMeta: true,
        origin: { kind: "peer" },
        message: { content: "message from a peer" },
      },
      claudeTranscript[3]!,
    ];
    expect(claudePlan(peer).turns.map((turn) => [turn.prompt, turn.reply])).toEqual([
      ["message from a peer", "One file."],
    ]);
  });

  it("leaves skill calls out of the expected tool count", () => {
    const skill = [
      claudeTranscript[0]!,
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [{ type: "tool_use", id: "k1", name: "Skill", input: { skill: "notes" } }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "k1", content: "loaded" }] },
      },
      claudeTranscript[3]!,
    ];
    expect(claudePlan(skill).turns[0]?.minTools).toBe(0);
  });

  it("reports a failed tool call as a failure", () => {
    const failed = [
      ...claudeTranscript.slice(0, 2),
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }],
        },
      },
    ];
    const names = claudePlan(failed).events.map((event) => event.payload.hook_event_name);
    expect(names).toContain("PostToolUseFailure");
    expect(names).not.toContain("PostToolUse");
  });

  it("fires the compaction hooks around a compaction", () => {
    const compacted = [
      { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual" } },
      { type: "user", isCompactSummary: true, message: { content: "summary" } },
    ];
    expect(
      claudePlan(compacted).events.map((event) => [
        event.payload.hook_event_name,
        event.payload.trigger,
      ]),
    ).toEqual([
      ["SessionStart", "manual"],
      ["PreCompact", "manual"],
      ["PostCompact", "auto"],
      ["SessionEnd", "auto"],
    ]);
  });

  it("replays a subagent's hooks before its Agent call finishes", () => {
    const launched = [
      { type: "user", sessionId: "s1", message: { content: "explore" } },
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [
            { type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "Explore" } },
          ],
        },
      },
      {
        type: "user",
        toolUseResult: { agentId: "x1" },
        message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "done" }] },
      },
      {
        type: "assistant",
        message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
      },
    ];
    const subagent = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t9", name: "Bash", input: {} }] },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "found" }] } },
    ];
    const subagentLines = subagent.map((line) => JSON.stringify(line));
    const plan = claudePlan(launched, (agentId) => (agentId === "x1" ? subagentLines : undefined));
    expect(plan.subagents).toEqual([
      { agentId: "x1", toolUseId: "a1", agentType: "Explore", lines: subagentLines },
    ]);
    expect(
      plan.events.map((event) => [
        event.payload.hook_event_name,
        event.agentId,
        event.payload.agent_type,
        event.transcriptLines,
      ]),
    ).toEqual([
      ["SessionStart", undefined, undefined, 0],
      ["UserPromptSubmit", undefined, undefined, 0],
      ["PreToolUse", undefined, undefined, 2],
      ["PreToolUse", "x1", "Explore", 1],
      ["PostToolUse", "x1", "Explore", 2],
      ["SubagentStop", "x1", "Explore", 3],
      ["PostToolUse", undefined, undefined, 3],
      ["Stop", undefined, undefined, 4],
      ["SessionEnd", undefined, undefined, 4],
    ]);
    expect(plan.events[5]?.payload.last_assistant_message).toBe("found");
    expect(plan.turns[0]?.minTools).toBe(2);
  });

  it("replays a background subagent alongside the main thread by time", () => {
    const launched = [
      { type: "user", sessionId: "s1", timestamp: at(0), message: { content: "explore" } },
      {
        type: "assistant",
        timestamp: at(1),
        message: { id: "m1", content: [{ type: "tool_use", id: "b1", name: "Task", input: {} }] },
      },
      {
        type: "user",
        timestamp: at(2),
        toolUseResult: { agentId: "x2", status: "async_launched" },
        message: { content: [{ type: "tool_result", tool_use_id: "b1" }] },
      },
      {
        type: "assistant",
        timestamp: at(5),
        message: { id: "m2", content: [{ type: "tool_use", id: "t5", name: "Bash", input: {} }] },
      },
      {
        type: "user",
        timestamp: at(6),
        message: { content: [{ type: "tool_result", tool_use_id: "t5" }] },
      },
      {
        type: "assistant",
        timestamp: at(9),
        message: { id: "m3", stop_reason: "end_turn", content: [{ type: "text", text: "Ok." }] },
      },
    ];
    const subagent = [
      {
        type: "assistant",
        timestamp: "2026-01-01T00:00:01.500Z",
        message: { content: [{ type: "tool_use", id: "s1", name: "Read", input: {} }] },
      },
      {
        type: "user",
        timestamp: at(3),
        message: { content: [{ type: "tool_result", tool_use_id: "s1" }] },
      },
      { type: "assistant", timestamp: at(7), message: { content: [{ type: "text", text: "bg" }] } },
    ].map((line) => JSON.stringify(line));
    const plan = claudePlan(launched, (agentId) => (agentId === "x2" ? subagent : undefined));
    expect(
      plan.events.map((event) => [event.payload.hook_event_name, event.payload.tool_use_id]),
    ).toEqual([
      ["SessionStart", undefined],
      ["UserPromptSubmit", undefined],
      ["PreToolUse", "b1"],
      ["PostToolUse", "b1"],
      ["PreToolUse", "s1"],
      ["PostToolUse", "s1"],
      ["PreToolUse", "t5"],
      ["PostToolUse", "t5"],
      ["SubagentStop", undefined],
      ["Stop", undefined],
      ["SessionEnd", undefined],
    ]);
  });
});

describe("codexPlan", () => {
  it("expects one turn per prompt with its tools and reply", () => {
    expect(codexPlan(codexRollout).turns).toEqual([
      {
        prompt: "list files",
        command: "",
        minTools: 1,
        maxTools: 1,
        reply: "One file.",
        expectsModelCall: true,
      },
    ]);
  });

  it("expects no model call for a turn the model never answered", () => {
    const imported = [
      codexRollout[0]!,
      codexRollout[1]!,
      codexRollout[2]!,
      { type: "response_item", payload: { type: "message", role: "user", content: [] } },
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: null } },
    ];
    expect(codexPlan(imported).turns[0]?.expectsModelCall).toBe(false);
  });

  it("sends tool arguments as parsed JSON", () => {
    const tool = codexPlan(codexRollout).events.find(
      (event) => event.payload.hook_event_name === "PostToolUse",
    );
    expect(tool?.payload.tool_input).toEqual({ cmd: "ls" });
  });

  it("starts a fresh turn when a new task starts before the last one finished", () => {
    const abandoned = [
      ...codexRollout.slice(0, 3),
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
      { type: "event_msg", payload: { type: "user_message", message: "try again" } },
    ];
    expect(codexPlan(abandoned).turns.map((turn) => turn.prompt)).toEqual([
      "list files",
      "try again",
    ]);
  });

  it("reads prompts from the conversation when the session logged no prompt events", () => {
    const finish = { type: "event_msg", payload: { type: "task_complete" } };
    const newerSession = [
      codexRollout[0]!,
      codexRollout[1]!,
      codexUserMessage(
        "<environment_context>cwd</environment_context>",
        "<goal_context>ship it</goal_context>",
      ),
      codexUserMessage('<image name=[Image #1] path="dot.png">', "</image>", "What color?"),
      finish,
      codexUserMessage("<user_shell_command>\n<command>\nls\n</command>\n<result>a.txt</result>"),
      finish,
    ];
    expect(codexPlan(newerSession).turns.map((turn) => turn.prompt)).toEqual(["What color?", "ls"]);
  });

  it("leaves subagent threads to their parent", () => {
    const child = [
      { type: "session_meta", payload: { id: "c2", source: { subagent: {} } } },
      ...codexRollout.slice(1),
    ];
    expect(codexPlan(child).turns).toEqual([]);
  });
});

describe("cursorPlan", () => {
  it("expects one turn per prompt with its tools and reply", () => {
    expect(cursorPlan(cursorTranscript, noSubagents, "conv-1").turns).toEqual([
      {
        prompt: "list files",
        command: "",
        minTools: 1,
        maxTools: 1,
        reply: "One file.",
        expectsModelCall: true,
      },
    ]);
  });

  it("fires the hooks Cursor sends for one turn, in order", () => {
    const events = cursorPlan(cursorTranscript, noSubagents, "conv-1").events;
    expect(
      events.map(({ payload }) => [
        payload.hook_event_name,
        payload.conversation_id,
        payload.generation_id,
        payload.status,
      ]),
    ).toEqual([
      ["sessionStart", "conv-1", "", undefined],
      ["beforeSubmitPrompt", "conv-1", "conv-1-1", undefined],
      ["postToolUse", "conv-1", "conv-1-1", undefined],
      ["afterAgentResponse", "conv-1", "conv-1-1", undefined],
      ["stop", "conv-1", "conv-1-1", "completed"],
    ]);
  });

  it("stops an unfinished turn as aborted and starts the next one clean", () => {
    const readOnly = {
      role: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { path: "a.txt" } }] },
    };
    const interrupted = [...cursorTranscript.slice(0, 2), cursorTranscript[0]!, readOnly];
    const plan = cursorPlan([...interrupted, cursorTranscript[3]!], noSubagents, "conv-1");
    const stops = plan.events.filter(({ payload }) => payload.hook_event_name === "stop");
    expect(stops.map(({ payload }) => [payload.generation_id, payload.status])).toEqual([
      ["conv-1-1", "aborted"],
      ["conv-1-2", "completed"],
    ]);
    expect(plan.turns.map((turn) => [turn.minTools, turn.reply])).toEqual([
      [1, null],
      [1, null],
    ]);
  });
});
