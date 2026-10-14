import type { StoredCapture } from "../../storage/capture/models.js";
import type { LifecycleSnapshotState } from "./models.js";
export declare function readSnapshotState(records: readonly StoredCapture[], destinationFingerprint: string, revisionPrefix: string): LifecycleSnapshotState | "conflict" | undefined;
//# sourceMappingURL=snapshot-state.d.ts.map