export type StateEntries<T> = Record<string, T>;

export interface StateStoreOptions {
  path: string;
  warn?: (message: string) => void;
}

export interface StateStore<T> {
  read(): StateEntries<T>;
  update(fn: (state: StateEntries<T>) => StateEntries<T>): Promise<void>;
}

export interface StateEntryWithUpdated {
  updated?: string;
}

export interface StatePatchOperation {
  path: string[];
  set?: unknown;
  unset?: boolean;
  add?: unknown[];
  remove?: unknown[];
}

export interface StatePatchEntry {
  session: string;
  removed?: boolean;
  operations?: StatePatchOperation[];
}

export type StatePatch = StatePatchEntry[];

export interface PendingStatePatches {
  files: string[];
  patches: StatePatch[];
}
