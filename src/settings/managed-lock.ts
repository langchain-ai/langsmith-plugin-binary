import { isDeepStrictEqual } from "node:util";
import {
  COMMON_DEFAULT_API_URL,
  MANAGED_CONFIG_OVERRIDE_FIELD_SEPARATOR,
  MANAGED_CONFIG_OVERRIDE_SOURCE_SEPARATOR,
  MANAGED_CONFIG_OVERRIDE_SOURCES,
  MANAGED_CONFIG_OVERRIDE_WARNING,
} from "./constants.js";
import type { CommonConfig, CommonConfigSources, LockableField } from "./models.js";
import { object } from "./utils/records.js";

export function lockedValues(common: CommonConfig): CommonConfig {
  const lock = { ...common };
  if (lock.api_key !== undefined || lock.replicas !== undefined)
    lock.api_url ??= COMMON_DEFAULT_API_URL;
  if (lock.api_url !== undefined || lock.project !== undefined) lock.replicas ??= [];
  if (lock.redact_extra_rules !== undefined) lock.redact ??= true;
  return lock;
}

export function lockedFields(lock: CommonConfig): LockableField[] {
  const fields: LockableField[] = [];
  for (const field of Object.keys(lock) as LockableField[]) {
    if (lock[field] !== undefined) fields.push(field);
  }
  return fields;
}

function overridesLock(value: unknown, locked: unknown): boolean {
  if (!object(value) || !object(locked)) return !isDeepStrictEqual(value, locked);
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(locked, key) && !isDeepStrictEqual(value[key], locked[key])) return true;
  }
  return false;
}

function overridingSources(
  sources: CommonConfigSources,
  field: LockableField,
  lock: CommonConfig,
): string[] {
  const overriding: string[] = [];
  for (const source of MANAGED_CONFIG_OVERRIDE_SOURCES) {
    const value = sources[source]?.[field];
    if (value !== undefined && overridesLock(value, lock[field])) overriding.push(source);
  }
  return overriding;
}

export function overrideDiagnostics(sources: CommonConfigSources, lock: CommonConfig): string[] {
  const overrides: string[] = [];
  for (const field of lockedFields(lock)) {
    const overriding = overridingSources(sources, field, lock);
    if (overriding.length === 0) continue;
    overrides.push(`${field} from ${overriding.join(MANAGED_CONFIG_OVERRIDE_SOURCE_SEPARATOR)}`);
  }
  if (overrides.length === 0) return [];
  const list = overrides.join(MANAGED_CONFIG_OVERRIDE_FIELD_SEPARATOR);
  return [MANAGED_CONFIG_OVERRIDE_WARNING.replace("{overrides}", list)];
}
