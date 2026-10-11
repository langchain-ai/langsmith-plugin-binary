import type { NormalizedRunContext, ResolvedUploadDestination } from "./models.js";
export declare function contextForDestination(context: NormalizedRunContext, destination: ResolvedUploadDestination): NormalizedRunContext;
export declare function runIdForDestination(runId: string, destination: ResolvedUploadDestination): string;
export declare function remapReplicaRunContext(context: NormalizedRunContext, sourceProjectName: string, destinationProjectName: string): NormalizedRunContext;
export declare function remapReplicaRunId(runId: string, projectName: string): string;
//# sourceMappingURL=replica-identifiers.d.ts.map