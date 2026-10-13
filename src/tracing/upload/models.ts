import type { Client, RunTree } from "langsmith";
import type {
  CodingAgentIntegration,
  CodingAgentMetadataMode,
  CodingAgentMetadataOptions,
} from "../../metadata/index.js";
import type { CodingAgentPrivacyContext } from "../../privacy/index.js";

export type UploadOperation = "post" | "patch";

export interface UploadRedactRule {
  pattern: string;
  replace?: string;
}

export interface SdkOmittedRunFields {
  tags?: string[];
  serialized?: object;
  events?: RunTree["events"];
}

export interface NormalizedRunSnapshot {
  id: string;
  name: string;
  run_type: string;
  start_time?: number | string;
  end_time?: number | string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  parent_run_id?: string;
  trace_id?: string;
  dotted_order?: string;
  tags?: string[];
  error?: string;
  serialized?: object;
  events?: RunTree["events"];
  reference_example_id?: string;
}

export interface NormalizedRunContext {
  id: string;
  name: string;
  run_type: string;
  start_time?: number | string;
  parent_run_id?: string;
  trace_id?: string;
  dotted_order?: string;
}

export interface NormalizedRunPatchValues {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  end_time?: number | string;
  error?: string;
  tags?: string[];
  serialized?: object;
  events?: RunTree["events"];
  reference_example_id?: string;
}

export type NormalizedRunPatchField = keyof NormalizedRunPatchValues;

export interface NormalizedRunPatch {
  fields: readonly NormalizedRunPatchField[];
  values: NormalizedRunPatchValues;
}

export type RedactedRunField = "inputs" | "outputs";

export type UploadAnonymizer = <T>(data: T) => T;

export interface UploadClientOptions extends Omit<LangSmithUploadDestinationConfig, "projectName"> {
  anonymizer?: UploadAnonymizer;
  redactedFields?: readonly RedactedRunField[];
}

export interface PreparedRunSubmissionBase {
  integration: CodingAgentIntegration;
  privacyMode: CodingAgentMetadataMode;
  redactedFields?: readonly RedactedRunField[];
  metadata: CodingAgentMetadataOptions;
}

export interface PreparedRunPostSubmission extends PreparedRunSubmissionBase {
  operation: "post";
  run: NormalizedRunSnapshot;
  privacyContext?: CodingAgentPrivacyContext;
}

export interface PreparedRunPatchSubmission extends PreparedRunSubmissionBase {
  operation: "patch";
  run: NormalizedRunContext;
  privacyContext: CodingAgentPrivacyContext;
  patch: NormalizedRunPatch;
}

export type PreparedRunSubmission = PreparedRunPostSubmission | PreparedRunPatchSubmission;

export interface LangSmithUploadDestinationConfig {
  apiKey: string;
  apiUrl: string;
  projectName: string;
  workspaceId?: string;
}

export interface LangSmithUploadReplicaConfig {
  apiKey?: string;
  apiUrl?: string;
  projectName?: string;
  workspaceId?: string;
  updates?: Record<string, unknown>;
}

export interface LangSmithUploadIdentityOptions {
  destinations: readonly LangSmithUploadDestinationConfig[];
  replicas?: readonly LangSmithUploadReplicaConfig[];
  redact: boolean;
  redactExtraRules?: readonly UploadRedactRule[];
}

export type LangSmithUploadWriterOptions = Omit<LangSmithUploadIdentityOptions, "replicas">;

export interface ResolvedUploadDestinationIdentity {
  id: string;
  apiKey: string;
  apiUrl: string;
  projectName: string;
  workspaceId?: string;
  sourceProjectName?: string;
  updates?: Record<string, unknown>;
}

export interface ResolvedUploadDestinationIdentities {
  accountFingerprint: string;
  destinations: ResolvedUploadDestinationIdentity[];
}

export interface ResolvedUploadDestination extends ResolvedUploadDestinationIdentity {
  anonymizer?: UploadAnonymizer;
  client: Client;
}

export interface ResolvedUploadDestinations {
  accountFingerprint: string;
  destinations: ResolvedUploadDestination[];
}

export interface UploadDestination {
  readonly id: string;
}

export interface UploadReceipt {
  destinationId: string;
  runId: string;
  operation: "posted" | "patched";
}

export type LangSmithRunCreate = Parameters<Client["createRun"]>[0];
export type LangSmithRunUpdate = Parameters<Client["updateRun"]>[1];

export interface LangSmithUploadWriter {
  readonly accountFingerprint: string;
  readonly destinations: readonly UploadDestination[];
  send(submission: PreparedRunSubmission, destinationId: string): Promise<UploadReceipt>;
}
