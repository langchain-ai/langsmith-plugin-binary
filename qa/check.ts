import type { AgentName, Scenario, TracedRun } from "./models.ts";

function descendantsOf(root: TracedRun, runs: TracedRun[]): TracedRun[] {
  return runs.filter((run) => run.trace_id === root.trace_id && run.id !== root.id);
}

function hasText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasText);
  if (typeof value === "object" && value !== null) return Object.values(value).some(hasText);
  return false;
}

function endTimeFailure(run: TracedRun): string | undefined {
  if (run.end_time === null) return `${run.run_type} run "${run.name}" never ended`;
  if (Date.parse(run.end_time) < Date.parse(run.start_time)) {
    return `${run.run_type} run "${run.name}" ends before it starts`;
  }
  return undefined;
}

export function checkRuns(scenario: Scenario, runs: TracedRun[]): string[] {
  const failures: string[] = [];
  const roots = runs
    .filter((run) => run.parent_run_id === null)
    .toSorted((left, right) => Date.parse(left.start_time) - Date.parse(right.start_time));
  if (roots.length !== scenario.turns.length) {
    failures.push(`expected ${scenario.turns.length} turns but found ${roots.length}`);
  }

  for (const [index, turn] of scenario.turns.entries()) {
    const root = roots[index];
    if (root === undefined) continue;
    const label = `turn ${index + 1}`;
    const children = descendantsOf(root, runs);
    const tools = children.filter((run) => run.run_type === "tool");
    if (!JSON.stringify(root.inputs).includes(turn.prompt))
      failures.push(`${label} is missing the user prompt`);
    if (!hasText(root.outputs)) failures.push(`${label} is missing the final reply`);
    if (!children.some((run) => run.run_type === "llm"))
      failures.push(`${label} has no model call`);
    if (tools.length < turn.minTools)
      failures.push(`${label} has ${tools.length} tool runs, expected ${turn.minTools}`);
    const expectedOutput = turn.toolOutputContains;
    if (
      expectedOutput !== undefined &&
      !tools.some((tool) => JSON.stringify(tool.outputs).includes(expectedOutput))
    ) {
      failures.push(`${label} has no tool output containing "${expectedOutput}"`);
    }
  }

  for (const run of runs) {
    const failure = endTimeFailure(run);
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}

export function checkHooks(scenario: Scenario, agent: AgentName, firedEvents: string[]): string[] {
  return scenario.hooksPerTurn[agent].flatMap((event) => {
    const fired = firedEvents.filter((name) => name === event).length;
    return fired === scenario.turns.length
      ? []
      : [`${event} fired ${fired} times for ${scenario.turns.length} turns`];
  });
}
