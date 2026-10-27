import { HOOK_OUTPUTS_KEY } from "./hook-outputs-constants.js";
import type { HookOutput } from "./hook-outputs-models.js";

export function hookOutputs(
  hooks: readonly HookOutput[],
): Partial<Record<typeof HOOK_OUTPUTS_KEY, HookOutput[]>> {
  if (hooks.length === 0) return {};
  return { [HOOK_OUTPUTS_KEY]: hooks.map(({ name, output }) => ({ name, output })) };
}
