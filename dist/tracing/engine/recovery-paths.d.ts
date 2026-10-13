import type { TracingEngineBackgroundRecoveryPaths, TracingEngineScope } from "./models.js";
export declare function backgroundRecoveryPathSegments(scope: Pick<TracingEngineScope, "integration" | "accountFingerprint">): string[];
export declare function backgroundRecoveryPaths(storageRoot: string, scope: Pick<TracingEngineScope, "integration" | "accountFingerprint">): TracingEngineBackgroundRecoveryPaths;
//# sourceMappingURL=recovery-paths.d.ts.map