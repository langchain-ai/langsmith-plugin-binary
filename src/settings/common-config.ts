import { COMMON_BOOLEAN_SETTINGS } from "./constants.js";
import { readManagedConfigFile } from "./managed-config.js";
import { lockedFields, lockedValues, overrideDiagnostics } from "./managed-lock.js";
import type {
  CommonConfig,
  CommonConfigSources,
  CommonReplica,
  MergeCommonConfigOptions,
  MergedCommonConfig,
  SdkReplica,
} from "./models.js";
import { warnOnce } from "./utils/warnings.js";

/** Resolve the first supplied value from sources ordered highest priority first. */
function resolveField<K extends keyof CommonConfig>(
  sources: readonly CommonConfig[],
  field: K,
): CommonConfig[K] {
  return sources.find((source) => source[field] !== undefined)?.[field];
}

/**
 * Metadata shallow-merges per key. envFirst opts into uniform environment-first
 * precedence; by default switches retain the legacy file-first precedence.
 */
export function mergeCommonConfig(
  sources: CommonConfigSources,
  options: MergeCommonConfigOptions = {},
): MergedCommonConfig {
  const {
    harness = {},
    root = {},
    user = {},
    userRoot = {},
    env = {},
    defaults = {},
    managed = readManagedConfigFile(),
  } = sources;
  const lock = lockedValues(managed.common);
  const files = [harness, root, user, userRoot];
  const precedence = [lock, env, ...files, defaults];
  const switches = options.envFirst ? precedence : [lock, ...files, env, defaults];
  const merged: MergedCommonConfig = {
    enabled: false,
    defaultMuted: false,
    redact: true,
    locked: lockedFields(lock),
    diagnostics: [...managed.diagnostics, ...overrideDiagnostics(sources, lock)],
  };
  for (const field of ["enabled", "defaultMuted"] as const) {
    merged[field] = resolveField(switches, field) ?? COMMON_BOOLEAN_SETTINGS[field].default;
  }
  if (managed.status === "invalid") {
    merged.enabled = false;
    if (managed.diagnostics[0] !== undefined) merged.managedConfigProblem = managed.diagnostics[0];
  }
  warnOnce(merged.diagnostics);
  merged.api_key = resolveField(precedence, "api_key");
  merged.api_url = resolveField(precedence, "api_url");
  merged.project = resolveField(precedence, "project");
  merged.replicas = resolveField(precedence, "replicas");
  merged.redact = resolveField(precedence, "redact") ?? true;
  merged.redact_extra_rules = resolveField(precedence, "redact_extra_rules");
  if (precedence.some((source) => source.metadata !== undefined)) {
    // Spread defines own properties (including __proto__), unlike assignment into a target.
    merged.metadata = [...precedence]
      .reverse()
      .reduce<Record<string, unknown>>(
        (metadata, source) => ({ ...metadata, ...source.metadata }),
        {},
      );
  }
  return merged;
}

/** Convert validated canonical FILE replicas only. Legacy SDK environment tuples belong to adapters. */
export function toSdkReplicas(
  replicas: readonly CommonReplica[] | undefined,
): SdkReplica[] | undefined {
  return replicas?.map((replica) => ({
    ...(replica.api_url === undefined ? {} : { apiUrl: replica.api_url }),
    ...(replica.api_key === undefined ? {} : { apiKey: replica.api_key }),
    ...(replica.project === undefined ? {} : { projectName: replica.project }),
    ...(replica.updates === undefined ? {} : { updates: replica.updates }),
  }));
}
