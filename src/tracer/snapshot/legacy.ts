import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { TRACER_FOLDER_MODE } from "../constants.js";
import type { SessionSnapshot } from "../models.js";
import { tracerPaths } from "../paths.js";
import {
  LEGACY_ENGINE_FOLDER,
  LEGACY_IMPORT_WINDOW_MS,
  LEGACY_STATE_FILE,
} from "./snapshot-constants.js";
import type { LegacyImport } from "./snapshot-models.js";
import { loadSnapshot, writeSnapshot } from "./snapshot.js";

export function importLegacyState(options: LegacyImport): number {
  if (!isAbsolute(options.stateFolder)) {
    throw new Error(
      `refusing to import legacy state from relative folder "${options.stateFolder}"`,
    );
  }
  const legacyEngine = join(options.stateFolder, LEGACY_ENGINE_FOLDER);
  const legacyState = join(options.stateFolder, LEGACY_STATE_FILE);
  if (!existsSync(legacyEngine) && !existsSync(legacyState)) return 0;
  const paths = tracerPaths(options.stateFolder);
  const saved = loadSnapshot(paths.snapshot).snapshot;
  const legacySessions = existsSync(legacyState) ? options.readLegacySessions(legacyState) : [];
  const cutoff = Date.now() - LEGACY_IMPORT_WINDOW_MS;
  const imported: SessionSnapshot[] = legacySessions
    .filter(
      (legacy) => legacy.updatedAt >= cutoff && saved.sessions[legacy.sessionId] === undefined,
    )
    .map((legacy) => ({
      sessionId: legacy.sessionId,
      integration: options.integration,
      writer: options.writer,
      bookmarks: { [legacy.transcriptPath]: { path: legacy.transcriptPath, offset: 0 } },
      pendingNotes: [],
      builderState: undefined,
      tracingMode: legacy.tracingMode,
      ended: false,
    }));
  for (const session of imported) saved.sessions[session.sessionId] = session;
  mkdirSync(paths.folder, { recursive: true, mode: TRACER_FOLDER_MODE });
  writeSnapshot(paths.snapshot, saved);
  rmSync(legacyEngine, { recursive: true, force: true });
  rmSync(legacyState, { force: true });
  return imported.length;
}
