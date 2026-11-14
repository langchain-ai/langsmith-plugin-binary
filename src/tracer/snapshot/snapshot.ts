import { existsSync, readFileSync } from "node:fs";
import { publishByRename } from "../../utils/files/publish.js";
import type { TracerSnapshot } from "../models.js";
import {
  SNAPSHOT_FILE_MODE,
  SNAPSHOT_TEMP_SUFFIX,
  SNAPSHOT_VERSION,
} from "./snapshot-constants.js";
import type { LoadedSnapshot } from "./snapshot-models.js";

export function loadSnapshot(path: string): LoadedSnapshot {
  const empty: TracerSnapshot = { version: SNAPSHOT_VERSION, sessions: {} };
  if (!existsSync(path)) return { snapshot: empty };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TracerSnapshot>;
    if (parsed.version !== SNAPSHOT_VERSION || typeof parsed.sessions !== "object") {
      return { snapshot: empty, problem: `ignored ${path} since its version is unknown` };
    }
    return { snapshot: parsed as TracerSnapshot };
  } catch (error) {
    return { snapshot: empty, problem: `ignored unreadable ${path}: ${String(error)}` };
  }
}

export function writeSnapshot(path: string, snapshot: TracerSnapshot): void {
  publishByRename(path, JSON.stringify(snapshot), SNAPSHOT_TEMP_SUFFIX, SNAPSHOT_FILE_MODE);
}
