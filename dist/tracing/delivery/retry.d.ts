import type { CaptureRetry } from "../../storage/capture/models.js";
import type { DeliveryDroppedWork } from "./models.js";
export declare function isRetryable(error: unknown): boolean;
export declare function rejection(error: unknown): DeliveryDroppedWork;
export declare function authHint(status: number | undefined): string;
export declare function nextRetry(previous: CaptureRetry | undefined, baseMs: number): CaptureRetry;
//# sourceMappingURL=retry.d.ts.map