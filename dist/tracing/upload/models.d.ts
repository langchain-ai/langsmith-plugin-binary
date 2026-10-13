export type NormalizedRunPatchField = "inputs" | "outputs" | "end_time" | "error" | "tags" | "serialized" | "events" | "reference_example_id";
export interface UploadRedactRule {
    pattern: string;
    replace?: string;
}
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
//# sourceMappingURL=models.d.ts.map