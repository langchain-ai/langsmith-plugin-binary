import { join } from "node:path";
import { claimStateEntry } from "../storage/state-claim.js";
import {
  NOTICE_DEFAULT_COOLDOWN_MINUTES,
  NOTICE_KEY_SEPARATOR,
  NOTICE_MINUTE_MS,
  NOTICE_OFF,
  NOTICE_STATE_FILE,
} from "./constants.js";
import type { NoticeOptions } from "./models.js";

const shownInProcess = new Set<string>();

export async function shouldShowNotice(options: NoticeOptions): Promise<boolean> {
  if (options.cooldown === NOTICE_OFF) return false;
  const windowMs = (options.cooldown ?? NOTICE_DEFAULT_COOLDOWN_MINUTES) * NOTICE_MINUTE_MS;
  const key = `${options.plugin}${NOTICE_KEY_SEPARATOR}${options.kind}`;
  try {
    return await claimStateEntry(join(options.storageRoot, NOTICE_STATE_FILE), key, windowMs);
  } catch {
    if (options.persistentOnly || shownInProcess.has(key)) return false;
    shownInProcess.add(key);
    return true;
  }
}
