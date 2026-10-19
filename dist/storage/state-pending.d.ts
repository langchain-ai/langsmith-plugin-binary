import type { PendingStatePatches, StateEntries, StatePatch } from "./state-models.js";
export declare function diffState<T>(before: StateEntries<T>, after: StateEntries<T>): StatePatch;
export declare function applyPatches<T>(state: StateEntries<T>, patches: readonly StatePatch[]): StateEntries<T>;
export declare function writePending(stateFilePath: string, patch: StatePatch): void;
export declare function readPending(stateFilePath: string): PendingStatePatches;
export declare function hasRecentPending(stateFilePath: string): boolean;
export declare function removePending(stateFilePath: string, files: readonly string[]): void;
//# sourceMappingURL=state-pending.d.ts.map