import type { DeliveryPolicy, DrainOptions } from "./models.js";
export declare function validateDrainRequest(request: DrainOptions): void;
export declare function snapshotWriter(writer: DrainOptions["writer"]): DrainOptions["writer"];
export declare function resolvePolicy(policy: Partial<DeliveryPolicy> | undefined): DeliveryPolicy;
//# sourceMappingURL=coordinator-policy.d.ts.map