import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPILED_BINARY_ENTRY_PREFIXES, SYSTEM_CERTIFICATES_FILE_NAME, WORKER_LOG_APPEND_FLAG, WORKER_LOG_FILE_NAME, WORKER_LOG_MAX_BYTES, WORKER_LOG_MODE, WORKER_LOG_TRUNCATE_FLAG, WORKER_NO_PID_MESSAGE, } from "./constants.js";
import { builtAsBinary } from "../utils/binary-runtime.js";
import { trustSystemCertificates } from "../utils/tls/system-certificates.js";
export function launchDetachedWorker(args, options = {}) {
    const root = options.storageRoot;
    const log = root === undefined ? undefined : openLog(join(root, WORKER_LOG_FILE_NAME));
    const certificates = root === undefined
        ? undefined
        : trustSystemCertificates(join(root, SYSTEM_CERTIFICATES_FILE_NAME), process.env);
    if (log !== undefined && certificates?.warning !== undefined)
        logWarning(log, certificates.warning);
    const child = spawn(options.executable ?? process.execPath, [...scriptArguments(), ...args], {
        detached: true,
        env: certificates?.environment ?? process.env,
        stdio: log === undefined ? "ignore" : ["ignore", log, log],
        windowsHide: true,
    });
    if (log !== undefined)
        closeSync(log);
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", () => {
            if (child.pid === undefined) {
                reject(new Error(WORKER_NO_PID_MESSAGE));
                return;
            }
            child.unref();
            resolve(child.pid);
        });
    });
}
function scriptArguments() {
    const entry = process.argv[1];
    const compiled = builtAsBinary() ||
        entry === undefined ||
        COMPILED_BINARY_ENTRY_PREFIXES.some((prefix) => entry.startsWith(prefix));
    return compiled ? [] : [entry];
}
function openLog(path) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
        const flag = size > WORKER_LOG_MAX_BYTES ? WORKER_LOG_TRUNCATE_FLAG : WORKER_LOG_APPEND_FLAG;
        return openSync(path, flag, WORKER_LOG_MODE);
    }
    catch {
        return undefined;
    }
}
function logWarning(log, warning) {
    try {
        writeSync(log, `${warning}\n`);
    }
    catch {
        return;
    }
}
//# sourceMappingURL=worker-launch.js.map