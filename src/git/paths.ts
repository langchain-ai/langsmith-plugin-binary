import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GIT_DIRECTORY_NAME, GIT_FILE_POINTER, GIT_MARKERS } from "./constants.js";
import type { GitMarker } from "./models.js";

function gitMarkerAt(directory: string): GitMarker {
  const marker = join(directory, GIT_DIRECTORY_NAME);
  try {
    if (statSync(marker).isDirectory()) return GIT_MARKERS.REPOSITORY_ROOT;
  } catch {
    return GIT_MARKERS.NOTHING_HERE;
  }
  return gitDirectoryPointedAt(directory, marker) !== undefined
    ? GIT_MARKERS.REPOSITORY_ROOT
    : GIT_MARKERS.ONLY_GIT_CAN_SAY;
}

function gitDirectoryPointedAt(directory: string, marker: string): string | undefined {
  try {
    const pointer = readFileSync(marker, "utf-8").match(GIT_FILE_POINTER)?.[1];
    if (pointer === undefined) return undefined;
    const gitDirectory = resolve(directory, pointer);
    return statSync(gitDirectory).isDirectory() ? gitDirectory : undefined;
  } catch {
    return undefined;
  }
}

export function gitDirectoryOf(root: string): string | undefined {
  const marker = join(root, GIT_DIRECTORY_NAME);
  try {
    if (statSync(marker).isDirectory()) return marker;
  } catch {
    return undefined;
  }
  return gitDirectoryPointedAt(root, marker);
}

export function rootFromGitMarker(directory: string): string | null | undefined {
  let current = resolve(directory);
  for (;;) {
    const marker = gitMarkerAt(current);
    if (marker === GIT_MARKERS.REPOSITORY_ROOT) return current;
    if (marker === GIT_MARKERS.ONLY_GIT_CAN_SAY) return undefined;
    const parent = dirname(current);
    const reachedFilesystemRoot = parent === current;
    if (reachedFilesystemRoot) return null;
    current = parent;
  }
}
