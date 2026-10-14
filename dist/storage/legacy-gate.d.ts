import type { LegacyDirectoryFileLockGate, TryAcquireFileLock } from "./models.js";
export declare function acquireLegacyDirectoryGate(filePath: string, deadline: number, tryAcquire: TryAcquireFileLock): Promise<LegacyDirectoryFileLockGate>;
export declare function releaseLegacyDirectoryGate(gate: LegacyDirectoryFileLockGate): Promise<void>;
//# sourceMappingURL=legacy-gate.d.ts.map