import { createCaptureStore } from "../../storage/capture/index.js";
import { createDeliveryAttemptStore } from "./attempt-store.js";
import type { DeliveryDrainCache, DeliveryDrainCounts, DeliveryPolicy, DrainOptions } from "./models.js";
export declare function drainLocked(captureStore: ReturnType<typeof createCaptureStore>, attemptStore: ReturnType<typeof createDeliveryAttemptStore>, integration: string, sessionId: string, policy: DeliveryPolicy, request: DrainOptions, drainCache: DeliveryDrainCache): Promise<DeliveryDrainCounts>;
//# sourceMappingURL=coordinator-internals.d.ts.map