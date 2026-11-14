import type { LangSmithUploadWriterOptions } from "../../tracing/upload/models.js";
import type { TracerSnapshot, TracingMode } from "../models.js";

export interface LoadedSnapshot {
  snapshot: TracerSnapshot;
  problem?: string;
}

export interface LegacySession {
  sessionId: string;
  transcriptPath: string;
  updatedAt: number;
  tracingMode?: TracingMode;
}

export interface LegacyImport {
  stateFolder: string;
  integration: string;
  writer: LangSmithUploadWriterOptions;
  readLegacySessions: (stateFile: string) => LegacySession[];
}
