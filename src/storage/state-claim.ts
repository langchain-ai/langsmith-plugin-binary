import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tryAcquireFileLock } from "./file-lock.js";
import {
  STATE_CLAIM_SKEW_MS,
  STATE_CLAIM_SUFFIX,
  STATE_PRIVATE_DIR_MODE,
} from "./state-constants.js";
import type { StateClaim } from "./state-models.js";
import { createStateStore } from "./state-store.js";

export async function claimStateEntry(
  path: string,
  key: string,
  windowMs: number,
): Promise<boolean> {
  mkdirSync(dirname(path), { recursive: true, mode: STATE_PRIVATE_DIR_MODE });
  const lock = await tryAcquireFileLock(`${path}${STATE_CLAIM_SUFFIX}`);
  if (lock === undefined) return false;
  try {
    const store = createStateStore<StateClaim>({ path, warn: () => undefined });
    const now = Date.now();
    const age = now - (store.read()[key]?.at ?? -Infinity);
    if (age > -STATE_CLAIM_SKEW_MS && age < windowMs) return false;
    await store.update((state) => ({ ...state, [key]: { at: now } }));
    return true;
  } finally {
    await lock.release();
  }
}
