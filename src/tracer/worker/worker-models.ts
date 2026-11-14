import type { SessionSnapshot, TracerPaths, TranscriptBuilder } from "../models.js";

export type WorkerSession = Omit<SessionSnapshot, "builderState"> & {
  builder: TranscriptBuilder;
};

export interface RotatedNotes {
  path: string;
  offset: number;
  rotatedAt: number;
}

export interface RotatedLeftover {
  path: string;
  base: number;
  nextBase: number;
}

export interface NotesRead {
  offset: number;
  size: number;
}

export interface LockHolder {
  pid: number;
  version: string;
}

export interface StopWorkerRequest {
  stopWorker: true;
  version: string;
}

export interface HookClientOptions {
  paths: TracerPaths;
  version: string;
  startWorker: () => void;
}

export type Log = (line: string) => void;
