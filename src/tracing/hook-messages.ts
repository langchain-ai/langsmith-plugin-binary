import { HOOK_MESSAGE_ROLE, HOOK_METADATA_KEY } from "./hook-messages-constants.js";
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
  const counts = new Map<string, number>();
  for (const { name } of hooks) counts.set(name, (counts.get(name) ?? 0) + 1);
  return { [HOOK_METADATA_KEY]: Object.fromEntries(counts) };
}
