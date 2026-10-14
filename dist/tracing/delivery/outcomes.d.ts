import type { EnumeratedCapture } from "../../storage/capture/models.js";
import type { DeliveryDependencyState, DeliveryDestinationResult, DeliveryDrainCache, DeliveryDroppedWork, DeliveryPendingCandidate } from "./models.js";
export declare function emptyDestinationResult(): DeliveryDestinationResult;
export declare function addDestinationResult(total: DeliveryDestinationResult, part: DeliveryDestinationResult): void;
export declare function dependenciesForDestination(drainCache: DeliveryDrainCache, entry: EnumeratedCapture, destination: string, inBatch?: ReadonlySet<string>): Promise<DeliveryDependencyState>;
export declare function recordDropped(drainCache: DeliveryDrainCache, candidate: DeliveryPendingCandidate, destination: string, { reason, status }: DeliveryDroppedWork): Promise<number>;
export declare function dropDependents(drainCache: DeliveryDrainCache, candidates: DeliveryPendingCandidate[]): Promise<number>;
export declare function settleDroppedDependency(drainCache: DeliveryDrainCache, candidate: DeliveryPendingCandidate, destination: string, result: DeliveryDestinationResult): Promise<void>;
//# sourceMappingURL=outcomes.d.ts.map