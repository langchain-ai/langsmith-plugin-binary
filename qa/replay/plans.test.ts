import { describe, expect, it } from "vitest";
import { claudePlan } from "./claude-plan.ts";
import { codexPlan } from "./codex-plan.ts";

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
