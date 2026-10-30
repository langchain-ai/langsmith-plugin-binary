import { FAKE_CALL_ID_PREFIX } from "../constants.ts";
import type { FakeStep, Scenario } from "../models.ts";
import { containsText } from "../utils/text.ts";

export function nextStep(scenario: Scenario, requestBody: string): FakeStep {
  const turnIndex = scenario.turns.findLastIndex((turn) => containsText(requestBody, turn.prompt));
  const turn = scenario.turns[turnIndex];
  if (turn === undefined) return { kind: "reply", text: "Ready." };
  const callId = `${FAKE_CALL_ID_PREFIX}${turnIndex + 1}`;
  if (requestBody.includes(callId))
    return { kind: "reply", text: `Finished turn ${turnIndex + 1}.` };
  return { kind: "tool", callId, command: turn.command };
}
