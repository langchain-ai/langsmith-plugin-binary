import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { describe } from "../../utils/errors.js";
import { NOTES_FILE_MODE, TRACER_FOLDER_MODE } from "../constants.js";
import type { HookNote, PositionedHookNote } from "../models.js";
import { liveLockHolder } from "./lock.js";
import { HOOK_WARNING_PREFIX } from "./worker-constants.js";
import type { HookClientOptions, StopWorkerRequest } from "./worker-models.js";

function positioned(note: HookNote): PositionedHookNote {
  const path = note.transcriptPath;
  const size = path === undefined ? undefined : statSync(path, { throwIfNoEntry: false })?.size;
  const transcriptSizes = path !== undefined && size !== undefined ? { [path]: size } : {};
  return { ...note, transcriptSizes };
}

const isNewerVersion = (candidate: string, current: string) =>
  candidate.localeCompare(current, undefined, { numeric: true }) > 0;

export function sendHookNote(note: HookNote, options: HookClientOptions): void {
  const { paths, version, startWorker } = options;
  try {
    mkdirSync(paths.folder, { recursive: true, mode: TRACER_FOLDER_MODE });
    appendFileSync(paths.notes, `${JSON.stringify(positioned(note))}\n`, { mode: NOTES_FILE_MODE });
    const holder = liveLockHolder(paths.lock);
    if (holder === undefined) startWorker();
    else if (isNewerVersion(version, holder.version)) {
      const request: StopWorkerRequest = { stopWorker: true, version };
      appendFileSync(paths.notes, `${JSON.stringify(request)}\n`, { mode: NOTES_FILE_MODE });
    }
  } catch (error) {
    process.stderr.write(`${HOOK_WARNING_PREFIX}${describe(error)}\n`);
  }
}
