import type { EnumeratedCapture, StoredCapture } from "../../storage/capture/models.js";
import type { DeliveryDependencyState, DeliveryDrainCache, DeliveryDestination, DeliveryPendingCandidate } from "./models.js";
export declare function pendingCandidates(drainCache: DeliveryDrainCache, entries: EnumeratedCapture[], destinations: readonly DeliveryDestination[]): Promise<DeliveryPendingCandidate[]>;
export declare function removeDroppedDependencies(drainCache: DeliveryDrainCache, candidate: DeliveryPendingCandidate): Promise<number>;
export declare function dependenciesForDestination(drainCache: DeliveryDrainCache, dependent: StoredCapture, destination: string): Promise<DeliveryDependencyState>;
export declare function dropPending(drainCache: DeliveryDrainCache, candidate: DeliveryPendingCandidate, reason: string): Promise<number>;
export declare function recordDroppedDestination(drainCache: DeliveryDrainCache, candidate: DeliveryPendingCandidate, destination: string, reason: string): Promise<number>;
//# sourceMappingURL=coordinator-dependencies.d.ts.map