import type { LifecycleCaptureResult, LifecycleSnapshotCaptureInput, LifecycleSnapshotCaptureOptions } from "./models.js";
export declare function captureLifecycleSnapshot(options: LifecycleSnapshotCaptureOptions, input: LifecycleSnapshotCaptureInput): Promise<LifecycleCaptureResult>;
export declare function withLifecycleSnapshotLock<T>(options: Pick<LifecycleSnapshotCaptureOptions, "storageRoot" | "integration" | "sessionId">, turnId: string, runId: string, operation: () => Promise<T>): Promise<T>;
//# sourceMappingURL=snapshot.d.ts.map