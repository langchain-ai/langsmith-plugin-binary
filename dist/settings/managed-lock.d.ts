import type { CommonConfig, CommonConfigSources, LockableField } from "./models.js";
export declare function lockedValues(common: CommonConfig): CommonConfig;
export declare function lockedFields(lock: CommonConfig): LockableField[];
export declare function overrideDiagnostics(sources: CommonConfigSources, lock: CommonConfig): string[];
//# sourceMappingURL=managed-lock.d.ts.map