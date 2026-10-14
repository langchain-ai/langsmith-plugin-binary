import type { DeliveryDestination, DeliveryDestinationResult, DeliveryDrainPassContext, DeliveryPendingCandidate } from "./models.js";
export declare function deliverBatch(context: DeliveryDrainPassContext, destination: DeliveryDestination, candidates: readonly DeliveryPendingCandidate[]): Promise<DeliveryDestinationResult>;
//# sourceMappingURL=deliver.d.ts.map