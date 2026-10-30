import { COMMAND_REPLY_INSTRUCTION, COMMAND_REPLY_MARKER } from "./constants.js";

export function commandReplyContext(reply: string): string {
  return `${COMMAND_REPLY_MARKER} ${COMMAND_REPLY_INSTRUCTION}\n\n${reply}`;
}
