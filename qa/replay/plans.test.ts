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

  it("leaves subagent threads to their parent", () => {
    const child = [
      { type: "session_meta", payload: { id: "c2", source: { subagent: {} } } },
      ...codexRollout.slice(1),
    ];
    expect(codexPlan(child).turns).toEqual([]);
  });
});
