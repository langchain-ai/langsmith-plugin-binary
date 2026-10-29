import type { FakeStep } from "../models.ts";
import { serverSentEvent as event } from "../utils/sse.ts";

function outputItem(step: FakeStep): Record<string, unknown> {
  if (step.kind === "tool") {
    return {
      type: "function_call",
      id: `fc_${step.callId}`,
      call_id: step.callId,
      name: "exec_command",
      arguments: JSON.stringify({ cmd: step.command }),
    };
  }
  return {
    type: "message",
    id: "msg_qa",
    role: "assistant",
    content: [{ type: "output_text", text: step.text }],
  };
}

export function responsesStream(step: FakeStep): string {
  const usage = {
    input_tokens: 10,
    input_tokens_details: null,
    output_tokens: 5,
    output_tokens_details: null,
    total_tokens: 15,
  };
  return [
    event("response.created", { response: { id: "resp_qa" } }),
    event("response.output_item.done", { item: outputItem(step) }),
    event("response.completed", { response: { id: "resp_qa", usage } }),
  ].join("");
}
