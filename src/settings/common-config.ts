import { closeSync, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  COMMON_BOOLEAN_SETTINGS,
  COMMON_CONFIG_FILE_NAME,
  COMMON_CONFIG_OPEN_FLAGS,
  COMMON_CONFIG_ROOT_FILE_NAME,
  COMMON_CONFIG_USER_ROOT_FILE_NAME,
  LOCKABLE_FIELDS,
  MANAGED_CONFIG_IGNORED_KEYS,
  MANAGED_CONFIG_INVALID,
  MANAGED_CONFIG_OPEN_FLAGS,
  MANAGED_CONFIG_OVERRIDE_SOURCES,
  MANAGED_CONFIG_OWNER_UID,
  MANAGED_CONFIG_DIRECTORY,
  MANAGED_CONFIG_FILE_NAME,
  MANAGED_CONFIG_UNSAFE_MODE,
  MANAGED_CONFIG_UNTRUSTED,
  UTF8_BOM,
} from "./constants.js";
import type {
  CommonConfig,
  CommonConfigFileOptions,
  CommonConfigFiles,
  CommonConfigResult,
  CommonConfigSources,
  CommonRedactRule,
  CommonReplica,
  ManagedConfigFileOptions,
  MergeCommonConfigOptions,
  MergedCommonConfig,
  SdkReplica,
} from "./models.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(raw?: Record<string, unknown>): CommonConfigResult {
  return {
    status: "invalid",
    common: { enabled: false, defaultMuted: true },
    ...(raw === undefined ? {} : { raw }),
    diagnostics: [
      "Invalid or unreadable common config; ordinary fields discarded, privacy switches restricted.",
    ],
  };
}

function parseReplica(value: unknown): CommonReplica | undefined {
  if (!object(value)) return undefined;
  const replica: CommonReplica = {};
  for (const [canonical, alias] of [
    ["api_url", "apiUrl"],
    ["api_key", "apiKey"],
    ["project", "projectName"],
  ] as const) {
    // Presence, not nullishness: an invalid canonical value must not select its alias.
    const selected = Object.hasOwn(value, canonical) ? canonical : alias;
    if (Object.hasOwn(value, selected)) {
      const entry = value[selected];
      if (typeof entry !== "string") return undefined;
      replica[canonical] = entry;
    }
  }
  if (Object.hasOwn(value, "updates")) {
    if (!object(value.updates)) return undefined;
    replica.updates = value.updates;
  }
  return replica;
}

/** Parse a decoded JSON value (not JSON text). Unknown/adapter fields do not affect common validity. */
export function parseCommonConfig(value: unknown): CommonConfigResult {
  if (!object(value)) return invalid();
  const common: CommonConfig = {};
  const diagnostics: string[] = [];
  for (const field of ["enabled", "defaultMuted"] as const) {
    if (!Object.hasOwn(value, field)) continue;
    const entry = value[field];
    common[field] = typeof entry === "boolean" ? entry : COMMON_BOOLEAN_SETTINGS[field].restrictive;
    if (typeof entry !== "boolean") diagnostics.push(`Invalid ${field}; using restrictive value.`);
  }
  for (const field of ["api_key", "api_url", "project"] as const) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== "string") return invalid(value);
    common[field] = value[field];
  }
  if (Object.hasOwn(value, "redact")) {
    if (typeof value.redact !== "boolean") return invalid(value);
    common.redact = value.redact;
  }
  if (Object.hasOwn(value, "metadata")) {
    if (!object(value.metadata)) return invalid(value);
    common.metadata = value.metadata;
  }
  if (Object.hasOwn(value, "replicas")) {
    if (!Array.isArray(value.replicas)) return invalid(value);
    const replicas: CommonReplica[] = [];
    for (const entry of value.replicas) {
      const replica = parseReplica(entry);
      if (replica === undefined) return invalid(value);
      replicas.push(replica);
    }
    common.replicas = replicas;
  }
  if (Object.hasOwn(value, "redact_extra_rules")) {
    if (!Array.isArray(value.redact_extra_rules)) return invalid(value);
    const rules: CommonRedactRule[] = [];
    for (const rule of value.redact_extra_rules) {
      if (!object(rule) || typeof rule.pattern !== "string" || !Object.hasOwn(rule, "pattern")) {
        return invalid(value);
      }
      const hasReplace = Object.hasOwn(rule, "replace");
      if (hasReplace && typeof rule.replace !== "string") return invalid(value);
      try {
        new RegExp(rule.pattern, "g");
      } catch {
        return invalid(value);
      }
      rules.push({
        pattern: rule.pattern,
        ...(hasReplace ? { replace: rule.replace as string } : {}),
      });
    }
    common.redact_extra_rules = rules;
  }
  return { status: "valid", common, raw: value, diagnostics };
}

/** Follow readable symlinks, but never read directories/devices/FIFOs. Only true ENOENT is absent. */
export function readCommonConfigFile(path: string): CommonConfigResult {
  let fd: number;
  try {
    fd = openSync(path, COMMON_CONFIG_OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        lstatSync(path);
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code === "ENOENT") {
          return absent();
        }
      }
    }
    return invalid();
  }
  try {
    if (!fstatSync(fd).isFile()) return invalid();
    return parseCommonConfig(JSON.parse(readFileSync(fd, "utf8")));
  } catch {
    return invalid();
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

function absent(): CommonConfigResult {
  return { status: "absent", common: {}, diagnostics: [] };
}

function ownedSafely(stats: Stats, ownerUid: number): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.uid === ownerUid &&
    (stats.mode & MANAGED_CONFIG_UNSAFE_MODE) === 0
  );
}

function managedConfigPath(home: string | undefined): string | undefined {
  if (process.platform === "win32") return undefined;
  let accountHome = home;
  try {
    accountHome = userInfo().homedir;
  } catch {}
  return accountHome === undefined
    ? undefined
    : join(accountHome, MANAGED_CONFIG_DIRECTORY, MANAGED_CONFIG_FILE_NAME);
}

function refuseManaged(diagnostic: string): CommonConfigResult {
  return { status: "invalid", common: {}, diagnostics: [diagnostic] };
}

export function readManagedConfigFile(
  options: ManagedConfigFileOptions = {},
  home?: string,
): CommonConfigResult {
  const path = options.path ?? managedConfigPath(home);
  if (path === undefined) return absent();
  const ownerUid = options.ownerUid ?? MANAGED_CONFIG_OWNER_UID;
  let fd: number;
  try {
    fd = openSync(path, MANAGED_CONFIG_OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return absent();
    return refuseManaged(code === "ELOOP" ? MANAGED_CONFIG_UNTRUSTED : MANAGED_CONFIG_INVALID);
  }
  let raw: unknown;
  try {
    const file = fstatSync(fd);
    if (!file.isFile()) return refuseManaged(MANAGED_CONFIG_INVALID);
    if (
      (options.checkOwnership ?? true) &&
      !(ownedSafely(file, ownerUid) && ownedSafely(lstatSync(dirname(path)), ownerUid))
    ) {
      return refuseManaged(MANAGED_CONFIG_UNTRUSTED);
    }
    raw = JSON.parse(readFileSync(fd, "utf8").replace(UTF8_BOM, ""));
  } catch {
    return refuseManaged(MANAGED_CONFIG_INVALID);
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
  if (!object(raw)) return refuseManaged(MANAGED_CONFIG_INVALID);
  const lockable = LOCKABLE_FIELDS.filter((field) => Object.hasOwn(raw, field));
  const parsed = parseCommonConfig(
    Object.fromEntries(lockable.map((field) => [field, raw[field]])),
  );
  if (parsed.status === "invalid") return refuseManaged(MANAGED_CONFIG_INVALID);
  if (parsed.common.api_url !== undefined) parsed.common.replicas ??= [];
  const ignoresKeys = Object.keys(raw).length > lockable.length;
  return {
    status: "valid",
    common: parsed.common,
    diagnostics: ignoresKeys ? [MANAGED_CONFIG_IGNORED_KEYS] : [],
  };
}

function overrideDiagnostics(sources: CommonConfigSources, locked: CommonConfig): string[] {
  return LOCKABLE_FIELDS.flatMap((field) =>
    locked[field] === undefined
      ? []
      : MANAGED_CONFIG_OVERRIDE_SOURCES.filter((source) => {
          const value = sources[source]?.[field];
          return value !== undefined && !isDeepStrictEqual(value, locked[field]);
        }).map((source) => `Ignored ${field} from ${source} because the managed config locks it.`),
  );
}

export function readCommonConfigFiles(options: CommonConfigFileOptions): CommonConfigFiles {
  const { cwd, home, harnessDirectory } = options;
  return {
    harness: readCommonConfigFile(join(cwd, harnessDirectory, COMMON_CONFIG_FILE_NAME)),
    root: readCommonConfigFile(join(cwd, COMMON_CONFIG_ROOT_FILE_NAME)),
    user: home
      ? readCommonConfigFile(join(home, harnessDirectory, COMMON_CONFIG_FILE_NAME))
      : absent(),
    userRoot: home ? readCommonConfigFile(join(home, COMMON_CONFIG_USER_ROOT_FILE_NAME)) : absent(),
    managed: readManagedConfigFile(options.managed, home),
  };
}

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
    managed,
  } = sources;
  const files = [harness, root, user, userRoot];
  const precedence = [env, ...files, defaults];
  const lockedPrecedence = [managed.common, ...precedence];
  const switches = options.envFirst ? precedence : [...files, env, defaults];
  const merged: MergedCommonConfig = {
    enabled: false,
    defaultMuted: false,
    redact: true,
    locked: LOCKABLE_FIELDS.filter((field) => managed.common[field] !== undefined),
    diagnostics: [...managed.diagnostics, ...overrideDiagnostics(sources, managed.common)],
  };
  for (const field of ["enabled", "defaultMuted"] as const) {
    merged[field] = resolveField(switches, field) ?? COMMON_BOOLEAN_SETTINGS[field].default;
  }
  if (managed.status === "invalid") merged.enabled = false;
  merged.api_key = resolveField(precedence, "api_key");
  merged.api_url = resolveField(lockedPrecedence, "api_url");
  merged.project = resolveField(precedence, "project");
  merged.replicas = resolveField(lockedPrecedence, "replicas");
  merged.redact = resolveField(lockedPrecedence, "redact") ?? true;
  merged.redact_extra_rules = resolveField(lockedPrecedence, "redact_extra_rules");
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
