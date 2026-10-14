import { createCaptureStore } from "../../storage/capture/index.js";
import type { CaptureScope, EnumeratedCapture, OutcomeReadResult, StoredCapture } from "../../storage/capture/models.js";
import type { DeliveryDrainCache, DeliveryDestination } from "./models.js";
export declare function requireDeliveredCompactionReceipts(captureStore: ReturnType<typeof createCaptureStore>, captures: EnumeratedCapture[], destinations: readonly DeliveryDestination[]): Promise<void>;
export declare function createDrainCache(store: ReturnType<typeof createCaptureStore>): DeliveryDrainCache;
export declare function deliveryKey(scope: CaptureScope, destination: string): string;
export declare function requireOutcome(drainCache: DeliveryDrainCache, scope: CaptureScope, destination: string): Promise<OutcomeReadResult>;
export declare function countPending(drainCache: DeliveryDrainCache, entries: EnumeratedCapture[], destinations: readonly DeliveryDestination[]): Promise<number>;
export declare function scopeOf(record: StoredCapture): CaptureScope;
//# sourceMappingURL=coordinator-receipts.d.ts.map