import type { CodingAgentMetadataOptions } from "../metadata/index.js";
import type { LangSmithUploadWriterOptions } from "../tracing/upload/models.js";
import type { LegacySession } from "./snapshot/snapshot-models.js";

export type TranscriptLine = Record<string, unknown>;

export type TracingMode = "full" | "metadata" | "off";

export interface HookNote {
  integration: string;
  event: string;
  sessionId: string;
  transcriptPath?: string;
  agentId?: string;
  tracingMode?: TracingMode;
  details?: Record<string, unknown>;
  writer: LangSmithUploadWriterOptions;
}

export interface PositionedHookNote extends HookNote {
  transcriptSizes: Record<string, number>;
}

export interface Bookmark {
  path: string;
  offset: number;
  lastLineId?: string;
}

export interface ReadLine {
  line: TranscriptLine;
  end: number;
}

export interface RunPost {
  id: string;
  name: string;
  run_type: string;
  trace_id: string;
  dotted_order: string;
  parent_run_id?: string;
  start_time: string;
  end_time?: string;
  inputs?: unknown;
  outputs?: unknown;
  error?: string;
  extra?: Record<string, unknown>;
  metadata: CodingAgentMetadataOptions;
  tracingMode: TracingMode;
}

export type RunPatch = Pick<
  RunPost,
  "id" | "name" | "run_type" | "trace_id" | "dotted_order" | "metadata" | "tracingMode"
> &
  Partial<
    Omit<
      RunPost,
      "id" | "name" | "run_type" | "trace_id" | "dotted_order" | "metadata" | "tracingMode"
    >
  >;

export interface RunSink {
  post: (run: RunPost) => void;
  patch: (patch: RunPatch) => void;
}

export interface TranscriptBuilder {
  lineId: (line: TranscriptLine) => string | undefined;
  readLine: (transcriptPath: string, line: TranscriptLine) => void;
  receiveNote: (note: HookNote) => void;
  transcripts: () => string[];
  state: () => unknown;
}

export interface BuilderContext {
  sessionId: string;
  savedState: unknown;
  sink: RunSink;
}

export type CreateTranscriptBuilder = (context: BuilderContext) => TranscriptBuilder;

export interface SessionSnapshot {
  sessionId: string;
  integration: string;
  writer: LangSmithUploadWriterOptions;
  bookmarks: Record<string, Bookmark>;
  pendingNotes: PositionedHookNote[];
  builderState: unknown;
  tracingMode?: TracingMode | undefined;
  ended: boolean;
}

export interface NotesBookmark {
  base: number;
  offset: number;
}

export interface TracerSnapshot {
  version: number;
  sessions: Record<string, SessionSnapshot>;
  notes?: NotesBookmark;
}

export interface UploadQueue {
  post: (sessionId: string, writer: LangSmithUploadWriterOptions, run: RunPost) => void;
  patch: (sessionId: string, writer: LangSmithUploadWriterOptions, patch: RunPatch) => void;
  pendingFor: (sessionId: string) => number;
  idle: () => boolean;
  full: () => boolean;
  flush: () => void;
}

export interface TracerPaths {
  folder: string;
  lock: string;
  snapshot: string;
  notes: string;
  log: string;
}

export type ReadNewLines = (
  bookmark: Bookmark,
  lineId: (line: TranscriptLine) => string | undefined,
) => ReadLine[];

export interface SnapshotStore {
  load: () => TracerSnapshot | undefined;
  save: (snapshot: TracerSnapshot) => void;
}

export interface StartTracerOptions {
  agentStateFolder: string;
  integration: string;
  version: string;
  writer: LangSmithUploadWriterOptions;
  createBuilder: CreateTranscriptBuilder;
  readLegacySessions: (stateFile: string) => LegacySession[];
}

export interface WorkerOptions {
  paths: TracerPaths;
  createBuilder: CreateTranscriptBuilder;
  createQueue: (log: (line: string) => void) => UploadQueue;
  readNewLines: ReadNewLines;
  snapshots: SnapshotStore;
  version: string;
  upgradeState: () => void;
}
