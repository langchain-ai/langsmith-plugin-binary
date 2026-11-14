import type { SessionSnapshot, TracerPaths, TranscriptBuilder } from "../models.js";

export type WorkerSession = Omit<SessionSnapshot, "builderState"> & {
  builder: TranscriptBuilder;
};

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
