import type { BackgroundWorkerScope } from "./models.js";
export declare function validateWorkerScope(scope: BackgroundWorkerScope): void;
export declare function workerDirectory(storageRoot: string, scope: BackgroundWorkerScope): string;
export declare function workerLockPath(storageRoot: string, scope: BackgroundWorkerScope): string;
export declare function workerPendingPath(storageRoot: string, scope: BackgroundWorkerScope): string;
export declare function workerActivePath(storageRoot: string, scope: BackgroundWorkerScope, markerId: string): string;
export declare function workerAttemptPath(storageRoot: string, scope: BackgroundWorkerScope, markerId: string, attempt: number): string;
export declare function workerLaunchPath(storageRoot: string, scope: BackgroundWorkerScope): string;
//# sourceMappingURL=paths.d.ts.map