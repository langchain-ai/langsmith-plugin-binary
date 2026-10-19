import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import {
  ACCOUNT_LOOKUP_TIMEOUT_MS,
  LINUX_ACCOUNT_LIST_FILE,
  LINUX_ACCOUNT_HOME_FIELD,
  LINUX_ACCOUNT_LOOKUPS,
  MACOS_ACCOUNT_LOOKUP,
  MACOS_ACCOUNT_LOOKUP_ARGUMENTS,
  MACOS_ACCOUNT_HOME_FIELD,
  ACCOUNT_FIELD_SEPARATOR,
  ACCOUNT_ID_FIELD,
} from "../constants.js";

let cachedBunHome: { home: string | undefined } | undefined;

export function accountHomeDirectory(): string | undefined {
  if (process.versions.bun === undefined) return nodeAccountHome();
  cachedBunHome ??= { home: bunAccountHome() };
  return cachedBunHome.home;
}

function bunAccountHome(): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  if (process.platform === "darwin") return macosAccountHome(uid);
  return linuxAccountHome(uid);
}

function nodeAccountHome(): string | undefined {
  try {
    return userInfo().homedir;
  } catch {
    return undefined;
  }
}

function macosAccountHome(uid: number): string | undefined {
  const entry = runAccountLookup(MACOS_ACCOUNT_LOOKUP, [
    ...MACOS_ACCOUNT_LOOKUP_ARGUMENTS,
    String(uid),
  ]);
  return homeField(entry, MACOS_ACCOUNT_HOME_FIELD);
}

function linuxAccountHome(uid: number): string | undefined {
  const fromFile = accountListEntry(uid);
  if (fromFile !== undefined) return homeField(fromFile, LINUX_ACCOUNT_HOME_FIELD);
  for (const lookup of LINUX_ACCOUNT_LOOKUPS) {
    const entry = runAccountLookup(lookup, ["passwd", String(uid)]);
    if (entry !== undefined) return homeField(entry, LINUX_ACCOUNT_HOME_FIELD);
  }
  return undefined;
}

function accountListEntry(uid: number): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(LINUX_ACCOUNT_LIST_FILE, "utf8");
  } catch {
    return undefined;
  }
  for (const line of contents.split("\n")) {
    if (line.split(ACCOUNT_FIELD_SEPARATOR)[ACCOUNT_ID_FIELD] === String(uid)) return line;
  }
  return undefined;
}

function runAccountLookup(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: ACCOUNT_LOOKUP_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function homeField(entry: string | undefined, field: number): string | undefined {
  const home = entry?.split(ACCOUNT_FIELD_SEPARATOR)[field];
  return home !== undefined && isAbsolute(home) ? home : undefined;
}
