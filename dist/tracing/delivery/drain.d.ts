import type { CaptureStore } from "../../storage/capture/models.js";
import type { DeliveryDrainCache, DeliveryDrainCounts, DeliveryPolicy, DrainOptions } from "./models.js";
export declare function drainLocked(captureStore: CaptureStore, integration: string, sessionId: string, policy: DeliveryPolicy, request: DrainOptions, drainCache: DeliveryDrainCache): Promise<DeliveryDrainCounts>;
//# sourceMappingURL=drain.d.ts.map