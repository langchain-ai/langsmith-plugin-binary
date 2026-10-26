import { HOOK_METADATA_KEY } from "../metadata/constants.js";
import { HOOK_MESSAGE_ROLE } from "./hook-messages-constants.js";
import type { HookMessage, HookOutput } from "./hook-messages-models.js";

export function hookMessage(hook: HookOutput): HookMessage {
  return {
    role: HOOK_MESSAGE_ROLE,
    name: hook.name,
    id: hook.id,
    content: `${hook.name}: ${hook.text}`,
  };
}

export function hookMetadata(
  hooks: readonly Pick<HookOutput, "name">[],
): Record<string, Record<string, number>> {
  if (hooks.length === 0) return {};
  const counts: Record<string, number> = {};
  for (const { name } of hooks) counts[name] = (counts[name] ?? 0) + 1;
  return { [HOOK_METADATA_KEY]: counts };
}
