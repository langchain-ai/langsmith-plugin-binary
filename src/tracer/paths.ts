import { join } from "node:path";
import {
  LOCK_FILE,
  LOG_FILE,
  NOTES_FILE,
  PLUGINS_BASE_FOLDER,
  SNAPSHOT_FILE,
} from "./constants.js";
import type { TracerPaths } from "./models.js";

export function tracerPaths(agentStateFolder: string): TracerPaths {
  const folder = join(agentStateFolder, PLUGINS_BASE_FOLDER);
  return {
    folder,
    lock: join(folder, LOCK_FILE),
    snapshot: join(folder, SNAPSHOT_FILE),
    notes: join(folder, NOTES_FILE),
    log: join(folder, LOG_FILE),
  };
}
