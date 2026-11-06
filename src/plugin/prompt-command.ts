import {
  COMMAND_ARGUMENT_START,
  COMMAND_REPLY_INSTRUCTION,
  COMMAND_REPLY_MARKER,
  COMMAND_REPLY_NOTICE_SEPARATOR,
  PROMPT_SUBMIT_EVENT,
  SYSTEM_MESSAGE_SEPARATOR,
} from "./constants.js";
import type {
  MatchedPromptCommand,
  PromptCommand,
  PromptCommandHandler,
  PromptCommandNotices,
  PromptCommandResponse,
} from "./models.js";

export function matchPromptCommand<Name extends string>(
  prompt: string,
  commands: readonly PromptCommand<Name>[],
): MatchedPromptCommand<Name> | undefined {
  for (const { name, text, takesArguments } of commands) {
    if (prompt === text) return { name, argumentText: "" };
    const rest = prompt.slice(text.length);
    if (takesArguments && prompt.startsWith(text) && COMMAND_ARGUMENT_START.test(rest)) {
      return { name, argumentText: rest };
    }
  }
  return undefined;
}

export async function runPromptCommand<Name extends string, Context>(
  command: MatchedPromptCommand<Name>,
  handlers: Record<Name, PromptCommandHandler<Context>>,
  context: Context,
): Promise<string> {
  try {
    return await handlers[command.name](command.argumentText, context);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function commandReplyContext(reply: string): string {
  return `${COMMAND_REPLY_MARKER} ${COMMAND_REPLY_INSTRUCTION}${COMMAND_REPLY_NOTICE_SEPARATOR}${reply}`;
}

export function promptCommandResponse(
  reply: string,
  notices: PromptCommandNotices,
): PromptCommandResponse {
  if (notices.blockReason !== undefined) {
    const reason = reply.includes(notices.blockReason)
      ? reply
      : `${reply}${COMMAND_REPLY_NOTICE_SEPARATOR}${notices.blockReason}`;
    return { decision: "block", reason };
  }
  const unrepeated = (notices.systemMessages ?? []).filter((notice) => !reply.includes(notice));
  return {
    ...(unrepeated.length === 0
      ? {}
      : { systemMessage: unrepeated.join(SYSTEM_MESSAGE_SEPARATOR) }),
    hookSpecificOutput: {
      hookEventName: PROMPT_SUBMIT_EVENT,
      additionalContext: commandReplyContext(reply),
    },
  };
}
