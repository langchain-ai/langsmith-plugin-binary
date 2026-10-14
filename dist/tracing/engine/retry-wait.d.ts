import type { RetryWaitResult } from "./models.js";
export declare function drainThroughBackoff<T extends RetryWaitResult>(drain: () => Promise<T>): Promise<T>;
//# sourceMappingURL=retry-wait.d.ts.map