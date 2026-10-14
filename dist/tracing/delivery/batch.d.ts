import type { DeliveryBatch, DeliveryPendingCandidate, DeliveryWriter } from "./models.js";
export declare function createBatch(): DeliveryBatch;
export declare function canJoinBatch(batch: DeliveryBatch, candidate: DeliveryPendingCandidate, writer: DeliveryWriter): boolean;
export declare function joinBatch(batch: DeliveryBatch, candidate: DeliveryPendingCandidate): void;
//# sourceMappingURL=batch.d.ts.map