export interface BackgroundWorkerScope {
    integration: string;
    accountFingerprint: string;
}
export type BackgroundWorkerPassResult = "idle" | "progressed" | "retryable-failure";
export type BackgroundWorkerTaskRunResult = BackgroundWorkerPassResult | "scope-mismatch";
export type BackgroundWorkerTask = () => BackgroundWorkerPassResult | Promise<BackgroundWorkerPassResult>;
export interface BackgroundWorkerRetryPolicy {
    maxAttempts: number;
    retryDelayMs: number;
}
export interface BackgroundWorkerOptions {
    storageRoot: string;
    scope: BackgroundWorkerScope;
    resolveScope: () => BackgroundWorkerScope | Promise<BackgroundWorkerScope>;
    launchWorker: () => number | Promise<number>;
    startupWaitMs?: number;
    reconstructPending?: BackgroundWorkerTask;
    drainPending: BackgroundWorkerTask;
    retryPolicy?: Partial<BackgroundWorkerRetryPolicy>;
}
export type BackgroundWorkerWakeResult = "queued" | "launched";
export type BackgroundWorkerRunResult = "idle" | "completed" | "retry-exhausted" | "scope-mismatch";
export interface BackgroundWorkerMarker {
    version: 1;
    id: string;
    sourcePid: number;
}
export interface BackgroundWorkerAttempt {
    version: 1;
    markerId: string;
    attempt: number;
}
export interface BackgroundWorkerLaunch {
    version: 1;
    pid: number;
    createdAtMs: number;
    expiresAtMs: number;
}
export interface BackgroundWorkerState {
    pending?: BackgroundWorkerMarker;
    active?: BackgroundWorkerMarker;
    attempts: BackgroundWorkerAttempt[];
    orphanedAttempts: BackgroundWorkerAttempt[];
}
export interface BackgroundWorkerLockedPassResult {
    scopeMismatch: boolean;
    processed: boolean;
    retryExhausted: boolean;
    retryPending: boolean;
    retryAttempted: boolean;
}
export interface BackgroundWorker {
    wake(): Promise<BackgroundWorkerWakeResult>;
    run(): Promise<BackgroundWorkerRunResult>;
}
//# sourceMappingURL=models.d.ts.map