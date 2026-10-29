import type { AnthropicContentBlock, FakeStep } from "../models.ts";
import { serverSentEvent as event } from "../utils/sse.ts";

function contentBlock(step: FakeStep): AnthropicContentBlock {
  if (step.kind === "tool") {
    return {
      start: { type: "tool_use", id: step.callId, name: "Bash", input: {} },
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: step.command }) },
    };
  }
  return { start: { type: "text", text: "" }, delta: { type: "text_delta", text: step.text } };
}

export function anthropicStream(step: FakeStep, model: string): string {
  const block = contentBlock(step);
  const usage = { input_tokens: 10, output_tokens: 5 };
  return [
    event("message_start", {
      message: { id: "msg_qa", type: "message", role: "assistant", model, content: [], usage },
    }),
    event("content_block_start", { index: 0, content_block: block.start }),
    event("content_block_delta", { index: 0, delta: block.delta }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", {
      delta: { stop_reason: step.kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    }),
    event("message_stop", {}),
  ].join("");
}
