import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RepositoryAttribution } from "../metadata/models.js";
import { fileSize, readText } from "../utils/files/read.js";
import {
  AMBIGUOUS_REF_AFFIXES,
  BRANCH_REF_PREFIX,
  CONDITIONAL_INCLUDE_SECTION,
  CONFIG_COMMENT_STARTS,
  CONFIG_INCLUDE_SECTIONS,
  CONFIG_KEY_PATTERN,
  CONFIG_KEYS,
  CONFIG_LINE_BREAK,
  CONFIG_SCOPES,
  CONFIG_SECTION_PATTERN,
  GIT_COMMON_DIRECTORY_FILE,
  GIT_CONFIG_FILE,
  GIT_HEAD_FILE,
  GIT_PACKED_REFS_FILE,
  LISTED_CONFIG_SEPARATOR,
  LISTED_CONFIG_VALUE_SEPARATOR,
  OBJECT_ID_PATTERN,
  PACKED_REFS_MAX_BYTES,
  SYMBOLIC_REF_PATTERN,
} from "./constants.js";
import type {
  GitConfigEntry,
  GitConfigKey,
  GitConfigValue,
  GitDirectories,
  GitInfo,
  GitRemote,
  RepositoryReader,
  SharedGitConfig,
} from "./models.js";
import { gitDirectoryOf } from "./paths.js";
import {
  getConfigList,
  getGitInfo,
  getGitUserName,
  getRepoName,
  repoNameFromRemotes,
  repositoryMetadataOf,
} from "./repository.js";

export function createFileReader(): RepositoryReader {
  let shared: SharedGitConfig | undefined;
  const configByRoot = new Map<string, GitConfigEntry[] | undefined>();

  function configFor(root: string): GitConfigEntry[] | undefined {
    if (!configByRoot.has(root)) configByRoot.set(root, readConfig(root));
    return configByRoot.get(root);
  }

  function readConfig(root: string): GitConfigEntry[] | undefined {
    if (!shared) {
      const listed = listedConfig(root);
      if (listed) shared = sharedLayers(listed);
      return listed;
    }
    const directories = gitDirectoriesOf(root);
    const local = shared.conditional || !directories ? undefined : localConfig(directories);
    return local ? [...shared.lower, ...local, ...shared.upper] : listedConfig(root);
  }

  return {
    repository: (root) => repositoryFromFiles(root, configFor(root)),
    userName: (root) => userNameFromConfig(root, configFor(root)),
  };
}

function repositoryFromFiles(
  root: string,
  config: GitConfigEntry[] | undefined,
): RepositoryAttribution {
  const directories = gitDirectoriesOf(root);
  const remotes = config && remotesFromConfig(config);
  const gitInfo = directories && gitInfoFromFiles(directories);
  return repositoryMetadataOf(
    remotes ? repoNameFromRemotes(remotes) : getRepoName(root),
    gitInfo ?? getGitInfo(root),
  );
}

function userNameFromConfig(
  root: string,
  config: GitConfigEntry[] | undefined,
): string | undefined {
  if (!config) return getGitUserName(root);
  const name = config.filter((entry) => matches(entry, CONFIG_KEYS.user)).at(-1);
  if (!name) return undefined;
  if (name.value === undefined) return getGitUserName(root);
  return name.value.trim() || undefined;
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
  const packed = packedRefs(directories);
  if (!packed) return undefined;
  const branch = ref.slice(BRANCH_REF_PREFIX.length);
  const shortNameIsAmbiguous = AMBIGUOUS_REF_AFFIXES.some(([prefix, suffix]) =>
    refExists(directories, packed, `${prefix}${branch}${suffix}`),
  );
  if (shortNameIsAmbiguous) return undefined;
  const commit = resolveRef(directories, packed, ref);
  return commit ? { branch, commit } : undefined;
}

function resolveRef(
  directories: GitDirectories,
  packed: Map<string, string>,
  ref: string,
): string | undefined {
  const loose = readText(join(directories.commonDirectory, ref))?.trim();
  if (loose !== undefined) return OBJECT_ID_PATTERN.test(loose) ? loose : undefined;
  return packed.get(ref);
}

function refExists(directories: GitDirectories, packed: Map<string, string>, ref: string): boolean {
  return (
    existsSync(join(directories.gitDirectory, ref)) ||
    existsSync(join(directories.commonDirectory, ref)) ||
    packed.has(ref)
  );
}

function packedRefs(directories: GitDirectories): Map<string, string> | undefined {
  const path = join(directories.commonDirectory, GIT_PACKED_REFS_FILE);
  if ((fileSize(path) ?? 0) > PACKED_REFS_MAX_BYTES) return undefined;
  const refs = new Map<string, string>();
  for (const line of (readText(path) ?? "").split(CONFIG_LINE_BREAK)) {
    const [objectId, ref] = line.split(" ");
    if (objectId && ref && OBJECT_ID_PATTERN.test(objectId)) refs.set(ref, objectId);
  }
  return refs;
}

function remotesFromConfig(config: GitConfigEntry[]): GitRemote[] | undefined {
  if (config.some((entry) => matches(entry, CONFIG_KEYS.insteadOf))) return undefined;
  const urlByRemote = new Map<string, string | undefined>();
  for (const entry of config) {
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

function listedConfig(root: string): GitConfigEntry[] | undefined {
  const listed = getConfigList(root);
  if (listed === undefined) return undefined;
  const fields = listed.split(LISTED_CONFIG_SEPARATOR);
  const entries: GitConfigEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [name = "", ...value] = fields[index + 1]!.split(LISTED_CONFIG_VALUE_SEPARATOR);
    const firstDot = name.indexOf(".");
    const lastDot = name.lastIndexOf(".");
    entries.push({
      scope: fields[index]!,
      section: name.slice(0, firstDot),
      ...(firstDot < lastDot ? { subsection: name.slice(firstDot + 1, lastDot) } : {}),
      key: name.slice(lastDot + 1),
      ...(value.length > 0 ? { value: value.join(LISTED_CONFIG_VALUE_SEPARATOR) } : {}),
    });
  }
  return entries;
}

function sharedLayers(listed: GitConfigEntry[]): SharedGitConfig {
  const repositoryScopes = new Set<string>([CONFIG_SCOPES.local, CONFIG_SCOPES.worktree]);
  return {
    lower: listed.filter(
      ({ scope }) => !repositoryScopes.has(scope!) && scope !== CONFIG_SCOPES.command,
    ),
    upper: listed.filter(({ scope }) => scope === CONFIG_SCOPES.command),
    conditional: listed.some(({ section }) => section === CONDITIONAL_INCLUDE_SECTION),
  };
}

function localConfig(directories: GitDirectories): GitConfigEntry[] | undefined {
  const text = readText(join(directories.commonDirectory, GIT_CONFIG_FILE)) ?? "";
  const entries = parseConfig(text);
  const unusual = entries?.some(
    (entry) =>
      CONFIG_INCLUDE_SECTIONS.has(entry.section) ||
      matches(entry, CONFIG_KEYS.worktreeConfig) ||
      (entry.value === undefined &&
        (matches(entry, CONFIG_KEYS.user) || matches(entry, CONFIG_KEYS.remoteUrl))),
  );
  return unusual ? undefined : entries;
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
