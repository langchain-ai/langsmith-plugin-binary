import type { StateEntries, StateEntryWithUpdated, StateStore, StateStoreOptions } from "./state-models.js";
export declare function createStateStore<T>(options: StateStoreOptions): StateStore<T>;
export declare function pruneStateEntries<T extends StateEntryWithUpdated>(state: StateEntries<T>, maxAgeMs: number, now?: number): StateEntries<T>;
//# sourceMappingURL=state-store.d.ts.map