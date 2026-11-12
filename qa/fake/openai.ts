import {
  FAKE_FUNCTION_CALL_ID_PREFIX,
  FAKE_MESSAGE_ID,
  FAKE_OPENAI_USAGE,
  FAKE_RESPONSE_ID,
} from "../constants.ts";
import type { FakeStep } from "../models.ts";
import { serverSentEvent as event } from "../utils/sse.ts";

function outputItem(step: FakeStep): Record<string, unknown> {
  if (step.kind === "tool") {
    return {
      type: "function_call",
      id: `${FAKE_FUNCTION_CALL_ID_PREFIX}${step.callId}`,
      call_id: step.callId,
      name: "exec_command",
      arguments: JSON.stringify({ cmd: step.command }),
    };
  }
  return {
    type: "message",
    id: FAKE_MESSAGE_ID,
    role: "assistant",
    content: [{ type: "output_text", text: step.text }],
  };
}

export function responsesStream(step: FakeStep): string {
  return [
    event("response.created", { response: { id: FAKE_RESPONSE_ID } }),
    event("response.output_item.done", { item: outputItem(step) }),
    event("response.completed", { response: { id: FAKE_RESPONSE_ID, usage: FAKE_OPENAI_USAGE } }),
  ].join("");
}
