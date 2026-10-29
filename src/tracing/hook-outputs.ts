import { HOOK_OUTPUTS_KEY } from "./engine/constants.js";
import type { HookOutput } from "./engine/models.js";

export function hookOutputs(
  hooks: readonly HookOutput[],
): Partial<Record<typeof HOOK_OUTPUTS_KEY, HookOutput[]>> {
  const valid = hooks.filter(
    (hook) => typeof hook?.name === "string" && typeof hook.output === "string",
  );
  if (valid.length === 0) return {};
  return { [HOOK_OUTPUTS_KEY]: valid.map(({ name, output }) => ({ name, output })) };
}
