import type { CaptureScope, CaptureStore, EnumeratedCapture, OutcomeReadResult } from "../../storage/capture/models.js";
import type { DeliveryDestination, DeliveryDrainCache, DeliveryPendingCount } from "./models.js";
export declare function deliveryKey(scope: CaptureScope, destination: string): string;
export declare function createDrainCache(store: CaptureStore): DeliveryDrainCache;
export declare function requireOutcome(drainCache: DeliveryDrainCache, scope: CaptureScope, destination: string): Promise<OutcomeReadResult>;
export declare function countPending(drainCache: DeliveryDrainCache, entries: EnumeratedCapture[], destinations: readonly DeliveryDestination[]): Promise<DeliveryPendingCount>;
//# sourceMappingURL=drain-cache.d.ts.map