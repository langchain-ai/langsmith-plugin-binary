import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  COMPILED_BINARY_ENTRY_PREFIXES,
  WORKER_LOG_APPEND_FLAG,
  WORKER_LOG_MAX_BYTES,
  WORKER_LOG_MODE,
  WORKER_LOG_TRUNCATE_FLAG,
  WORKER_NO_PID_MESSAGE,
} from "./constants.js";
import type { DetachedWorkerOptions } from "./models.js";
import { builtAsBinary } from "../utils/binary-runtime.js";

export function launchDetachedWorker(
  args: readonly string[],
  options: DetachedWorkerOptions = {},
): Promise<number> {
  const log = options.logFile === undefined ? undefined : openLog(options.logFile);
  const child = spawn(options.executable ?? process.execPath, [...scriptArguments(), ...args], {
    detached: true,
    stdio: log === undefined ? "ignore" : ["ignore", log, log],
    windowsHide: true,
  });
  if (log !== undefined) closeSync(log);
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

function scriptArguments(): string[] {
  const entry = process.argv[1];
  const compiled =
    builtAsBinary() ||
    entry === undefined ||
    COMPILED_BINARY_ENTRY_PREFIXES.some((prefix) => entry.startsWith(prefix));
  return compiled ? [] : [entry];
}

function openLog(path: string): number | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    const flag = size > WORKER_LOG_MAX_BYTES ? WORKER_LOG_TRUNCATE_FLAG : WORKER_LOG_APPEND_FLAG;
    return openSync(path, flag, WORKER_LOG_MODE);
  } catch {
    return undefined;
  }
}
