import { closeSync, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  MANAGED_CONFIG_DIRECTORY,
  MANAGED_CONFIG_FILE_NAME,
  MANAGED_CONFIG_INVALID,
  MANAGED_CONFIG_OPEN_FLAGS,
  MANAGED_CONFIG_OWNER_UID,
  GROUP_OR_OTHERS_WRITE_BITS,
  MANAGED_CONFIG_UNLOCKABLE_WARNING,
  MANAGED_CONFIG_UNSAFE_OWNERSHIP,
  UTF8_BOM,
} from "./constants.js";
import type { CommonConfigResult, ManagedConfigFileOptions, PluginFieldOptions } from "./models.js";
import { absent, parseCommonConfig } from "./parse.js";
import { accountHomeDirectory } from "./utils/account-home.js";
import { object } from "./utils/records.js";
import { warnOnce } from "./utils/warnings.js";

function onlyOwnerCanChange(stats: Stats, ownerUid: number): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.uid === ownerUid &&
    (stats.mode & GROUP_OR_OTHERS_WRITE_BITS) === 0
  );
}

function managedConfigPath(): string | undefined {
  if (process.platform === "win32") return undefined;
  const accountHome = accountHomeDirectory() ?? homedir();
  return join(accountHome, MANAGED_CONFIG_DIRECTORY, MANAGED_CONFIG_FILE_NAME);
}

function rejectManagedConfig(diagnostic: string): CommonConfigResult {
  return { status: "invalid", common: {}, diagnostics: [diagnostic] };
}

export function readManagedConfigFile(options: ManagedConfigFileOptions = {}): CommonConfigResult {
  const path = options.path ?? managedConfigPath();
  if (path === undefined) return absent();
  const ownerUid = options.ownerUid ?? MANAGED_CONFIG_OWNER_UID;
  let fd: number;
  try {
    fd = openSync(path, MANAGED_CONFIG_OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return absent();
    return rejectManagedConfig(
      code === "ELOOP" ? MANAGED_CONFIG_UNSAFE_OWNERSHIP : MANAGED_CONFIG_INVALID,
    );
  }
  let raw: unknown;
  try {
    const file = fstatSync(fd);
    if (!file.isFile()) return rejectManagedConfig(MANAGED_CONFIG_INVALID);
    if (
      (options.checkOwnership ?? true) &&
      !(
        onlyOwnerCanChange(file, ownerUid) && onlyOwnerCanChange(lstatSync(dirname(path)), ownerUid)
      )
    ) {
      return rejectManagedConfig(MANAGED_CONFIG_UNSAFE_OWNERSHIP);
    }
    raw = JSON.parse(readFileSync(fd, "utf8").replace(UTF8_BOM, ""));
  } catch {
    return rejectManagedConfig(MANAGED_CONFIG_INVALID);
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
  if (!object(raw)) return rejectManagedConfig(MANAGED_CONFIG_INVALID);
  const parsed = parseCommonConfig(raw);
  if (parsed.status === "invalid") return rejectManagedConfig(MANAGED_CONFIG_INVALID);
  return { status: "valid", common: parsed.common, raw, diagnostics: parsed.diagnostics };
}

export function lockPluginFields(
  managed: CommonConfigResult,
  fields: PluginFieldOptions,
): Record<string, unknown> {
  const raw = managed.raw ?? {};
  const present = (names: readonly string[]) => names.filter((name) => Object.hasOwn(raw, name));
  const ignored = present(fields.unlockable ?? []);
  if (ignored.length > 0)
    warnOnce([MANAGED_CONFIG_UNLOCKABLE_WARNING.replace("{fields}", ignored.join(", "))]);
  return Object.fromEntries(present(fields.lockable).map((name) => [name, raw[name]]));
}
