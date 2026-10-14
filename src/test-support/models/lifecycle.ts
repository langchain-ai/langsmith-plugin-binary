import type { CodingAgentMetadataOptions } from "../../metadata/models.js";
import type { CodingAgentPrivacyContext } from "../../privacy/models.js";
import type {
  NormalizedRunSnapshot,
  NormalizedRunPatchValues,
  RedactedRunField,
} from "../../tracing/upload/models.js";

export interface LocalRequest {
  method: string;
  path: string;
  wire?: string;
  payload: Record<string, unknown>;
}

export interface LocalEndpoint {
  url: string;
  requests: LocalRequest[];
  readonly httpRequests: number;
  failing: Set<number>;
  failingPaths: Set<string>;
  rejectedIds: Set<string>;
  state: { mode: "ok" | "down" | "hang" | "reject" };
  close(): Promise<void>;
}

export type TestRun = "root" | "child" | "sibling";

export interface TestSubmissionOptions {
  base?: Record<string, unknown>;
  metadata?: Partial<CodingAgentMetadataOptions>;
  privacyMode?: "full" | "metadata";
  privacyContext?: CodingAgentPrivacyContext;
  redactedFields?: RedactedRunField[];
  run?: { [Key in keyof NormalizedRunSnapshot]?: NormalizedRunSnapshot[Key] | undefined };
}

export type TestPatchValues = NormalizedRunPatchValues;
