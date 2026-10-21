import type { CaptureStore } from "../storage/capture/models.js";
import type { CodingAgentIntegration } from "../metadata/models.js";
import type {
  TracingEngineBackgroundRecoveryResult,
  TracingEngineSession,
  TracingEngineSessionCallbacks,
} from "../tracing/engine/models.js";
import type { ReconstructionCallback } from "../tracing/reconstruction/models.js";
import type { LangSmithUploadWriterOptions } from "../tracing/upload/models.js";

export interface PolicyFileOptions<T> {
  empty: () => T;
  parse: (value: unknown) => T;
  requireRegularFile?: boolean;
}

export interface PolicyUpdateResult {
  warning?: string;
}

export interface PluginSessionOptions {
  storageRoot: string;
  integration: CodingAgentIntegration;
  sessionId: string;
  writer: LangSmithUploadWriterOptions;
  currentWriter: () =>
    | LangSmithUploadWriterOptions
    | undefined
    | Promise<LangSmithUploadWriterOptions | undefined>;
  scheduleWake: (sessionId: string) => Promise<number>;
  reconstruct: ReconstructionCallback;
  startupWaitMs?: number;
  onRecoveryReport?: (result: TracingEngineBackgroundRecoveryResult) => void | Promise<void>;
}

export interface PluginSession {
  session: TracingEngineSession;
  sessionId: string;
  store: CaptureStore;
  fingerprint: string;
  callbacks: (sessionId: string) => TracingEngineSessionCallbacks;
}

export type HookRunner = () => Promise<unknown>;

export interface HookCommandOptions {
  usage: string;
  version: string;
  hooks: Readonly<Record<string, HookRunner>>;
  worker?: { command: string; run: (args: readonly string[]) => Promise<unknown> };
  onHookError: (name: string, error: unknown) => void;
  onUnknown: (argument: string | undefined) => void;
}

export interface DetachedWorkerOptions {
  executable?: string;
  storageRoot?: string;
}

export interface NoticeOptions {
  plugin: string;
  kind: string;
  cooldown?: number | "off" | undefined;
  storageRoot: string;
}
