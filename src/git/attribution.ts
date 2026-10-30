import { isAbsolute } from "node:path";
import { REPOSITORY_METADATA_KEYS } from "../metadata/constants.js";
import type { RepositoryAttribution } from "../metadata/models.js";
import type { ReconstructionToolOrigin } from "../tracing/reconstruction/models.js";
import { nearestExistingDirectory } from "../utils/paths.js";
import { MAX_SEEDED_FOLDERS } from "./constants.js";
import { createGitHubLoginFallback } from "./github-login.js";
import type {
  RepositoryAttributionSeed,
  RepositoryAttributor,
  RepositoryAttributorOptions,
} from "./models.js";
import { rootFromGitMarker } from "./paths.js";
import { getGitUserName, getRepoRoot, getRepositoryMetadata } from "./repository.js";

export function createRepositoryAttributor(
  options: RepositoryAttributorOptions,
): RepositoryAttributor {
  const seed = options.seed;
  const rootByDirectory = new Map<string, string | null | undefined>(
    Object.entries(seed?.roots ?? {}),
  );
  const attributionByRoot = new Map<string, RepositoryAttribution>();
  const metadataByRoot = new Map<string, RepositoryAttribution>(
    Object.entries(seed?.metadata ?? {}),
  );
  const identifierByRoot = new Map<string, RepositoryAttribution>(
    Object.entries(seed?.identifiers ?? {}),
  );
  const githubLogin = options.skipGitHubLogin
    ? undefined
    : createGitHubLoginFallback({ markerPath: options.githubLoginMarkerPath });

  function rootForPath(path: string): string | null | undefined {
    const directory = nearestExistingDirectory(path);
    if (!directory) return undefined;
    if (rootByDirectory.has(directory)) return rootByDirectory.get(directory);
    const walked = rootFromGitMarker(directory);
    const onlyGitCanSay = walked === undefined;
    const root = onlyGitCanSay ? getRepoRoot(directory) : walked;
    rootByDirectory.set(directory, root);
    return root;
  }

  function isSessionsOwnRepository(sessionCwd: string | undefined, root: string): boolean {
    return sessionCwd ? rootForPath(sessionCwd) === root : false;
  }

  function identifierForRoot(root: string): RepositoryAttribution {
    const cached = identifierByRoot.get(root);
    if (cached) return cached;
    const userName = getGitUserName(root, githubLogin && { githubLogin });
    const identifier: RepositoryAttribution = userName
      ? { ls_attribution_identifier: userName }
      : {};
    identifierByRoot.set(root, identifier);
    return identifier;
  }

  function attributionForRoot(root: string): RepositoryAttribution {
    const cached = attributionByRoot.get(root);
    if (cached) return cached;
    const attribution: RepositoryAttribution = {
      ...identifierForRoot(root),
      ...(metadataByRoot.get(root) ?? getRepositoryMetadata(root)),
    };
    attributionByRoot.set(root, attribution);
    return attribution;
  }

  function scopedToPath(
    base: Record<string, unknown> | undefined,
    origin: ReconstructionToolOrigin,
    pinned: ReadonlySet<string>,
  ): Record<string, unknown> | undefined {
    const namedSomewhereNothingSits = origin.namedAPath && !origin.path;
    if (namedSomewhereNothingSits) return base;

    const path = origin.path ?? origin.cwd;
    if (!path || !isAbsolute(path)) return base;

    const root = rootForPath(path);
    const gitCouldNotAnswer = root === undefined;
    if (gitCouldNotAnswer) return base;

    const pathIsInNoRepository = root === null;
    if (pathIsInNoRepository) return withoutRepositoryKeys(base, pinned);

    if (isSessionsOwnRepository(origin.cwd, root)) {
      return { ...base, ...withoutPinnedKeys(identifierForRoot(root), pinned) };
    }
    return {
      ...withoutRepositoryKeys(base, pinned),
      ...withoutPinnedKeys(attributionForRoot(root), pinned),
    };
  }

  function withSessionRepository(
    base: Record<string, unknown> | undefined,
    sessionCwd: string | undefined,
  ): Record<string, unknown> | undefined {
    const sessionRoot = sessionCwd ? rootForPath(sessionCwd) : undefined;
    if (typeof sessionRoot !== "string") return base;
    return { ...attributionForRoot(sessionRoot), ...base };
  }

  function toolMetadata(
    base: Record<string, unknown> | undefined,
    origin: ReconstructionToolOrigin,
  ): Record<string, unknown> | undefined {
    const pinned = new Set<string>(
      REPOSITORY_METADATA_KEYS.filter((key) => base?.[key] !== undefined),
    );
    return scopedToPath(withSessionRepository(base, origin.cwd), origin, pinned);
  }

  function turnMetadata(
    base: Record<string, unknown> | undefined,
    cwd: string | undefined,
    toolOrigins: Iterable<ReconstructionToolOrigin>,
  ): Record<string, unknown> | undefined {
    const sessionCwd = cwd ? { cwd } : {};
    const sessionRoot = cwd ? rootForPath(cwd) : undefined;
    if (typeof sessionRoot === "string") {
      return toolMetadata(base, { ...sessionCwd, namedAPath: false });
    }
    for (const { path, namedAPath } of toolOrigins) {
      if (!path) continue;
      const landedInRepository = typeof rootForPath(path) === "string";
      if (landedInRepository) return toolMetadata(base, { path, namedAPath, ...sessionCwd });
    }
    return base;
  }

  function capture(folders: Iterable<string>): RepositoryAttributionSeed {
    const captured: RepositoryAttributionSeed = { roots: {}, metadata: {}, identifiers: {} };
    for (const folder of [...new Set(folders)].slice(0, MAX_SEEDED_FOLDERS)) {
      const directory = nearestExistingDirectory(folder);
      const root = rootForPath(folder);
      if (!directory || root === undefined) continue;
      captured.roots[directory] = root;
      if (root === null) continue;
      captured.metadata[root] = metadataByRoot.get(root) ?? getRepositoryMetadata(root);
      const identifier = identifierForRoot(root);
      if (identifier.ls_attribution_identifier) captured.identifiers[root] = identifier;
    }
    return captured;
  }

  return { toolMetadata, turnMetadata, capture };
}

export function captureRepositoryAttribution(folders: Iterable<string>): RepositoryAttributionSeed {
  return createRepositoryAttributor({ githubLoginMarkerPath: "", skipGitHubLogin: true }).capture(
    folders,
  );
}

function withoutPinnedKeys(
  attribution: RepositoryAttribution,
  pinned: ReadonlySet<string>,
): Record<string, unknown> {
  if (pinned.size === 0) return { ...attribution };
  return Object.fromEntries(Object.entries(attribution).filter(([key]) => !pinned.has(key)));
}

function withoutRepositoryKeys(
  base: Record<string, unknown> | undefined,
  pinned: ReadonlySet<string>,
): Record<string, unknown> {
  const stripped: Record<string, unknown> = { ...base };
  for (const key of REPOSITORY_METADATA_KEYS) {
    if (!pinned.has(key)) delete stripped[key];
  }
  return stripped;
}
