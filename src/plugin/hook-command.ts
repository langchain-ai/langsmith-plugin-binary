import { describe } from "../utils/errors.js";
import {
  COMMAND_REPLY_INSTRUCTION,
  COMMAND_REPLY_MARKER,
  HOOK_ERROR_HANDLER_WARNING,
  HOOK_HELP_FLAGS,
  HOOK_OPTIONS_INVALID_MESSAGE,
  HOOK_VERSION_FLAGS,
} from "./constants.js";
import type { HookCommandOptions, HookRunner } from "./models.js";

export async function dispatchHookCommand(
  argv: readonly string[],
  options: HookCommandOptions,
): Promise<void> {
  assertHookOptions(options);
  const [argument, ...rest] = argv;
  if (argument !== undefined && HOOK_HELP_FLAGS.includes(argument)) {
    console.log(options.usage);
  } else if (argument !== undefined && HOOK_VERSION_FLAGS.includes(argument)) {
    console.log(options.version);
  } else if (argument !== undefined && options.worker?.command === argument) {
    await guarded(argument, () => options.worker!.run(rest), options);
  } else if (argument !== undefined && Object.hasOwn(options.hooks, argument)) {
    await guarded(argument, options.hooks[argument]!, options);
  } else {
    options.onUnknown(argument);
  }
}

async function guarded(name: string, run: HookRunner, options: HookCommandOptions): Promise<void> {
  try {
    await run();
  } catch (error) {
    reportHookError(name, error, options);
  }
}

function assertHookOptions(options: HookCommandOptions): void {
  if (
    options === null ||
    typeof options !== "object" ||
    options.hooks === null ||
    typeof options.hooks !== "object" ||
    typeof options.onHookError !== "function" ||
    typeof options.onUnknown !== "function"
  )
    throw new TypeError(HOOK_OPTIONS_INVALID_MESSAGE);
}

function reportHookError(name: string, error: unknown, options: HookCommandOptions): void {
  try {
    options.onHookError(name, error);
  } catch (handlerError) {
    console.warn(HOOK_ERROR_HANDLER_WARNING, describe(handlerError));
  }
}

export function commandReplyContext(reply: string): string {
  return `${COMMAND_REPLY_MARKER} ${COMMAND_REPLY_INSTRUCTION}\n\n${reply}`;
}
