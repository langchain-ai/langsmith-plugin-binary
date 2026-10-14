import { setTimeout as delay } from "node:timers/promises";
import { TRACING_ENGINE_MAX_RETRY_PASSES, TRACING_ENGINE_MAX_RETRY_WAIT_MS } from "./constants.js";
export async function drainThroughBackoff(drain) {
    let waitedMs = 0;
    let result = await drain();
    for (let pass = 0; pass < TRACING_ENGINE_MAX_RETRY_PASSES; pass += 1) {
        if (result.status !== "drained" || result.pending === 0 || result.nextRetryAtMs === undefined)
            break;
        const wait = Math.max(0, result.nextRetryAtMs - Date.now());
        if (waitedMs + wait > TRACING_ENGINE_MAX_RETRY_WAIT_MS)
            break;
        waitedMs += wait;
        await delay(wait);
        const waitedFor = result.nextRetryAtMs;
        result = await drain();
        if (result.status === "drained" && result.nextRetryAtMs === waitedFor)
            break;
    }
    return result;
}
//# sourceMappingURL=retry-wait.js.map