import { describe, expect, it } from "vitest";
import { checkHooks, checkRuns } from "./check.ts";
import type { Scenario, TracedRun } from "./models.ts";

const scenario: Scenario = {
  name: "two-turns",
  files: {},
  turns: [
    { prompt: "read notes", minTools: 1, toolOutputContains: "hello" },
    { prompt: "list files", minTools: 0 },
  ],
  hooksPerTurn: { claude: ["UserPromptSubmit", "Stop"], codex: ["Stop"] },
};

function run(overrides: Partial<TracedRun> & Pick<TracedRun, "id" | "trace_id">): TracedRun {
  return {
    name: "run",
    run_type: "chain",
    parent_run_id: null,
    start_time: "2026-10-29T10:00:00.000Z",
    end_time: "2026-10-29T10:00:05.000Z",
    inputs: {},
    outputs: {},
    ...overrides,
  };
}

function healthyRuns(): TracedRun[] {
  return [
    run({
      id: "r1",
      trace_id: "t1",
      inputs: { messages: ["read notes"] },
      outputs: { messages: ["it says hello"] },
    }),
    run({ id: "l1", trace_id: "t1", parent_run_id: "r1", run_type: "llm" }),
    run({
      id: "k1",
      trace_id: "t1",
      parent_run_id: "r1",
      run_type: "tool",
      outputs: { stdout: "hello" },
    }),
    run({
      id: "r2",
      trace_id: "t2",
      start_time: "2026-10-29T10:01:00.000Z",
      end_time: "2026-10-29T10:01:05.000Z",
      inputs: { messages: ["list files"] },
      outputs: { messages: ["two files"] },
    }),
    run({ id: "l2", trace_id: "t2", parent_run_id: "r2", run_type: "llm" }),
  ];
}

function withChange(id: string, change: Partial<TracedRun>): TracedRun[] {
  return healthyRuns().map((existing) =>
    existing.id === id ? { ...existing, ...change } : existing,
  );
}

describe("checkRuns", () => {
  it("passes a complete two-turn trace", () => {
    expect(checkRuns(scenario, healthyRuns())).toEqual([]);
  });

  it("catches a turn the plugin never uploaded", () => {
    const runs = healthyRuns().filter((existing) => existing.trace_id !== "t1");
    expect(checkRuns(scenario, runs)).toContain("expected 2 turns but found 1");
  });

  it("catches a turn that lost its user prompt", () => {
    expect(checkRuns(scenario, withChange("r2", { inputs: {} }))).toEqual([
      "turn 2 is missing the user prompt",
    ]);
  });

  it("catches a turn that lost its final reply", () => {
    expect(
      checkRuns(scenario, withChange("r1", { outputs: { messages: [{ content: "" }] } })),
    ).toEqual(["turn 1 is missing the final reply"]);
  });

  it("catches a turn with no model call", () => {
    const runs = healthyRuns().filter((existing) => existing.id !== "l2");
    expect(checkRuns(scenario, runs)).toEqual(["turn 2 has no model call"]);
  });

  it("catches a dropped tool run", () => {
    const runs = healthyRuns().filter((existing) => existing.id !== "k1");
    expect(checkRuns(scenario, runs)).toEqual([
      "turn 1 has 0 tool runs, expected 1",
      'turn 1 has no tool output containing "hello"',
    ]);
  });

  it("catches a tool run whose output was lost", () => {
    expect(checkRuns(scenario, withChange("k1", { outputs: {} }))).toEqual([
      'turn 1 has no tool output containing "hello"',
    ]);
  });

  it("catches a run left open", () => {
    expect(checkRuns(scenario, withChange("l1", { end_time: null }))).toEqual([
      'llm run "run" never ended',
    ]);
  });

  it("catches a run that ends before it starts", () => {
    const change = { end_time: "2026-10-29T09:59:59.000Z" };
    expect(checkRuns(scenario, withChange("k1", change))).toEqual([
      'tool run "run" ends before it starts',
    ]);
  });
});

describe("checkHooks", () => {
  it("passes when each hook fired once per turn", () => {
    expect(
      checkHooks(scenario, "claude", ["UserPromptSubmit", "Stop", "UserPromptSubmit", "Stop"]),
    ).toEqual([]);
  });

  it("catches a hook that fired too few times", () => {
    expect(
      checkHooks(scenario, "claude", ["UserPromptSubmit", "Stop", "UserPromptSubmit"]),
    ).toEqual(["Stop fired 1 times for 2 turns"]);
  });
});
