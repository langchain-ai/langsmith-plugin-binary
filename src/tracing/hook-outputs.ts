import { COMMAND_REPLY_MARKER } from "../plugin/constants.js";
import { HOOK_OUTPUTS_KEY } from "./engine/constants.js";
import type { HookOutput } from "./engine/models.js";

export function hookOutputs(
  hooks: readonly HookOutput[],
): Partial<Record<typeof HOOK_OUTPUTS_KEY, HookOutput[]>> {
  const valid = hooks.filter(
    (hook) =>
      typeof hook?.name === "string" &&
      typeof hook.output === "string" &&
      !hook.output.startsWith(COMMAND_REPLY_MARKER),
  );
  if (valid.length === 0) return {};
  return { [HOOK_OUTPUTS_KEY]: valid.map(({ name, output }) => ({ name, output })) };
}
