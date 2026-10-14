import { utimes } from "node:fs/promises";
import { FILE_LOCK_HEARTBEAT_MS, FILE_LOCK_HEARTBEAT_WARNING } from "./constants.js";
import { describe, errorCode } from "../utils/errors.js";
import { FILE_MISSING_CODE } from "../utils/constants.js";
const heartbeats = new Map();
export function startHeartbeat(path, id) {
    const timer = setInterval(() => {
        const now = new Date();
        utimes(path, now, now).catch(warnUnlessMissing);
    }, FILE_LOCK_HEARTBEAT_MS);
    timer.unref();
    heartbeats.set(id, timer);
}
export function stopHeartbeat(id) {
    clearInterval(heartbeats.get(id));
    heartbeats.delete(id);
}
function warnUnlessMissing(error) {
    if (errorCode(error) !== FILE_MISSING_CODE)
        console.warn(FILE_LOCK_HEARTBEAT_WARNING, describe(error));
}
//# sourceMappingURL=file-lock-heartbeat.js.map