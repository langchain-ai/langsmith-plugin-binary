import { createCaptureStore } from "../../storage/capture/index.js";
import type { EnumeratedCapture } from "../../storage/capture/models.js";
import { createDeliveryAttemptStore } from "./attempt-store.js";
import type { DeliveryDestination, DeliveryDrainCache, DeliveryDrainCounts, DeliveryPolicy, DrainOptions } from "./models.js";
export declare function requireDeliveredCompactionReceipts(captureStore: ReturnType<typeof createCaptureStore>, captures: EnumeratedCapture[], destinations: readonly DeliveryDestination[]): Promise<void>;
export declare function drainLocked(captureStore: ReturnType<typeof createCaptureStore>, attemptStore: ReturnType<typeof createDeliveryAttemptStore>, integration: string, sessionId: string, policy: DeliveryPolicy, request: DrainOptions, drainCache: DeliveryDrainCache): Promise<DeliveryDrainCounts>;
export declare function createDrainCache(store: ReturnType<typeof createCaptureStore>): DeliveryDrainCache;
export declare function countPending(drainCache: DeliveryDrainCache, entries: EnumeratedCapture[], destinations: readonly DeliveryDestination[]): Promise<number>;
export declare function validateDrainRequest(request: DrainOptions): void;
export declare function snapshotWriter(writer: DrainOptions["writer"]): DrainOptions["writer"];
export declare function resolvePolicy(policy: Partial<DeliveryPolicy> | undefined): DeliveryPolicy;
//# sourceMappingURL=coordinator-internals.d.ts.map