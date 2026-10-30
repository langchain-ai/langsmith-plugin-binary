import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RepositoryAttribution } from "../metadata/models.js";
import { findExecutable } from "../utils/desktop/launch.js";
import {
  AMBIGUOUS_REF_AFFIXES,
  BRANCH_REF_PREFIX,
  CONFIG_COMMENT_STARTS,
  CONFIG_INCLUDE_SECTIONS,
  CONFIG_KEY_PATTERN,
  CONFIG_KEYS,
  CONFIG_LINE_BREAK,
  CONFIG_OVERRIDE_ENV_KEYS,
  CONFIG_SECTION_PATTERN,
  CONFIG_WHITESPACE,
  DEFAULT_XDG_CONFIG_DIRECTORY,
  GIT_COMMAND,
  GIT_COMMON_DIRECTORY_FILE,
  GIT_CONFIG_FILE,
  GIT_HEAD_FILE,
  GIT_LEGACY_REMOTE_DIRECTORIES,
  GIT_PACKED_REFS_FILE,
  GLOBAL_CONFIG_FILE,
  OBJECT_ID_PATTERN,
  SYMBOLIC_REF_PATTERN,
  SYSTEM_CONFIG_PATHS,
  WINDOWS_PROGRAM_DATA_CONFIG_PATH,
  WINDOWS_SYSTEM_CONFIG_PATH,
  XDG_GIT_CONFIG_PATH,
} from "./constants.js";
import type {
  GitConfigEntry,
  GitConfigKey,
  GitConfigValue,
  GitDirectories,
  GitInfo,
  GitRemote,
} from "./models.js";
import { gitDirectoryOf } from "./paths.js";
import {
  getGitInfo,
  getGitUserName,
  getRepoName,
  repoNameFromRemotes,
  repositoryMetadataOf,
} from "./repository.js";

export function repositoryMetadataFromFiles(root: string): RepositoryAttribution {
  const directories = gitDirectoriesOf(root);
  const remotes = directories && remotesFromFiles(directories);
  const gitInfo = directories && gitInfoFromFiles(directories);
  return repositoryMetadataOf(
    remotes ? repoNameFromRemotes(remotes) : getRepoName(root),
    gitInfo ?? getGitInfo(root),
  );
}

export function userNameFromFiles(root: string): string | undefined {
  const directories = gitDirectoriesOf(root);
  const entries = directories && configEntries(directories);
  const names = entries?.filter((entry) => matches(entry, CONFIG_KEYS.user));
  const name = names?.at(-1)?.value?.trim().replace(CONFIG_WHITESPACE, " ");
  return name || getGitUserName(root);
}

function gitDirectoriesOf(root: string): GitDirectories | undefined {
  const gitDirectory = gitDirectoryOf(root);
  if (!gitDirectory) return undefined;
  const common = readText(join(gitDirectory, GIT_COMMON_DIRECTORY_FILE))?.trim();
  return { gitDirectory, commonDirectory: common ? resolve(gitDirectory, common) : gitDirectory };
}

function gitInfoFromFiles(directories: GitDirectories): GitInfo | undefined {
  const head = readText(join(directories.gitDirectory, GIT_HEAD_FILE))?.trim();
  if (!head) return undefined;
  if (OBJECT_ID_PATTERN.test(head)) return { commit: head };
  const ref = head.match(SYMBOLIC_REF_PATTERN)?.[1];
  if (!ref?.startsWith(BRANCH_REF_PREFIX)) return undefined;
  const branch = ref.slice(BRANCH_REF_PREFIX.length);
  const shortNameIsAmbiguous = AMBIGUOUS_REF_AFFIXES.some(([prefix, suffix]) =>
    refExists(directories, `${prefix}${branch}${suffix}`),
  );
  if (shortNameIsAmbiguous) return undefined;
  const commit = resolveRef(directories, ref);
  return commit ? { branch, commit } : undefined;
}

function resolveRef(directories: GitDirectories, ref: string): string | undefined {
  const loose = readText(join(directories.commonDirectory, ref))?.trim();
  if (loose !== undefined) return OBJECT_ID_PATTERN.test(loose) ? loose : undefined;
  return packedRefs(directories).get(ref);
}

function refExists(directories: GitDirectories, ref: string): boolean {
  return (
    existsSync(join(directories.gitDirectory, ref)) ||
    existsSync(join(directories.commonDirectory, ref)) ||
    packedRefs(directories).has(ref)
  );
}

function packedRefs(directories: GitDirectories): Map<string, string> {
  const refs = new Map<string, string>();
  const text = readText(join(directories.commonDirectory, GIT_PACKED_REFS_FILE)) ?? "";
  for (const line of text.split(CONFIG_LINE_BREAK)) {
    const [objectId, ref] = line.split(" ");
    if (objectId && ref && OBJECT_ID_PATTERN.test(objectId)) refs.set(ref, objectId);
  }
  return refs;
}

function remotesFromFiles(directories: GitDirectories): GitRemote[] | undefined {
  const hasLegacyRemotes = GIT_LEGACY_REMOTE_DIRECTORIES.some(
    (name) => listDirectory(join(directories.commonDirectory, name)).length > 0,
  );
  if (hasLegacyRemotes) return undefined;
  const entries = configEntries(directories);
  if (!entries || entries.some((entry) => matches(entry, CONFIG_KEYS.insteadOf))) return undefined;
  const urlByRemote = new Map<string, string | undefined>();
  for (const entry of entries) {
    if (!matches(entry, CONFIG_KEYS.remoteUrl) || entry.subsection === undefined) continue;
    if (!urlByRemote.has(entry.subsection)) urlByRemote.set(entry.subsection, entry.value);
  }
  const remotes: GitRemote[] = [];
  for (const name of [...urlByRemote.keys()].toSorted()) {
    const url = urlByRemote.get(name);
    if (!url) return undefined;
    remotes.push({ name, url });
  }
  return remotes;
}

function configEntries(directories: GitDirectories): GitConfigEntry[] | undefined {
  const paths = configPaths(directories);
  if (!paths) return undefined;
  const entries: GitConfigEntry[] = [];
  for (const path of paths) {
    const text = readText(path);
    if (text === undefined) continue;
    const parsed = parseConfig(text);
    if (!parsed) return undefined;
    entries.push(...parsed);
  }
  const unusual = entries.some(
    (entry) =>
      CONFIG_INCLUDE_SECTIONS.has(entry.section) || matches(entry, CONFIG_KEYS.worktreeConfig),
  );
  return unusual ? undefined : entries;
}

function configPaths(directories: GitDirectories): string[] | undefined {
  const { env } = process;
  if (CONFIG_OVERRIDE_ENV_KEYS.some((key) => env[key])) return undefined;
  const system = systemConfigPaths(env);
  if (!system) return undefined;
  const home = env.HOME || homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, DEFAULT_XDG_CONFIG_DIRECTORY);
  const global = env.GIT_CONFIG_GLOBAL
    ? [env.GIT_CONFIG_GLOBAL]
    : [join(xdg, ...XDG_GIT_CONFIG_PATH), join(home, GLOBAL_CONFIG_FILE)];
  return [...system, ...global, join(directories.commonDirectory, GIT_CONFIG_FILE)];
}

function systemConfigPaths(env: NodeJS.ProcessEnv): string[] | undefined {
  if (env.GIT_CONFIG_NOSYSTEM) return [];
  if (env.GIT_CONFIG_SYSTEM) return [env.GIT_CONFIG_SYSTEM];
  if (process.platform !== "win32") return SYSTEM_CONFIG_PATHS;
  const git = findExecutable(GIT_COMMAND, env, process.platform);
  if (!git) return undefined;
  const installed = join(dirname(dirname(git)), ...WINDOWS_SYSTEM_CONFIG_PATH);
  return env.ProgramData
    ? [join(env.ProgramData, ...WINDOWS_PROGRAM_DATA_CONFIG_PATH), installed]
    : [installed];
}

function parseConfig(text: string): GitConfigEntry[] | undefined {
  const entries: GitConfigEntry[] = [];
  let section: string | undefined;
  let subsection: string | undefined;
  let continues = false;
  for (const rawLine of text.split(CONFIG_LINE_BREAK)) {
    if (continues) {
      continues = scanValue(rawLine).continues;
      continue;
    }
    const line = rawLine.trim();
    if (!line || CONFIG_COMMENT_STARTS.has(line[0]!)) continue;
    if (line.startsWith("[")) {
      const header = line.match(CONFIG_SECTION_PATTERN);
      if (!header) return undefined;
      section = header[1]!.toLowerCase();
      subsection = header[2];
      continue;
    }
    const assignment = line.match(CONFIG_KEY_PATTERN);
    if (!assignment || section === undefined) return undefined;
    const scanned = assignment[2] === undefined ? { continues: false } : scanValue(assignment[2]);
    continues = scanned.continues;
    entries.push({
      section,
      ...(subsection === undefined ? {} : { subsection }),
      key: assignment[1]!.toLowerCase(),
      ...(scanned.value === undefined ? {} : { value: scanned.value }),
    });
  }
  return entries;
}

function scanValue(raw: string): GitConfigValue {
  let quoted = false;
  let plain = true;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!;
    if (character === "\\") {
      plain = false;
      if (index === raw.length - 1) return { continues: true };
      index++;
    } else if (character === '"') {
      plain = false;
      quoted = !quoted;
    } else if (!quoted && CONFIG_COMMENT_STARTS.has(character)) {
      return plain ? { value: raw.slice(0, index).trim(), continues: false } : { continues: false };
    }
  }
  return plain ? { value: raw.trim(), continues: false } : { continues: false };
}

function matches(entry: GitConfigEntry, { section, key }: GitConfigKey): boolean {
  return entry.section === section && entry.key === key;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function listDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
