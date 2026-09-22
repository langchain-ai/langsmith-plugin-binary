import * as fs from "node:fs/promises";
import { ABANDONED_LOCK_MS } from "../constants.js";

export async function acquireLock(
  lockFile: string,
  now: number,
): Promise<fs.FileHandle | undefined> {
  try {
    return await fs.open(lockFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const abandoned = await fs.stat(lockFile).then(
    (stats) => now - stats.mtimeMs > ABANDONED_LOCK_MS,
    () => false,
  );
  if (!abandoned) return undefined;

  try {
    await fs.unlink(lockFile);
    return await fs.open(lockFile, "wx", 0o600);
  } catch {
    return undefined;
  }
}

export async function releaseLock(lockFile: string, lock: fs.FileHandle): Promise<void> {
  await lock.close().catch(() => undefined);
  await fs.unlink(lockFile).catch(() => undefined);
}
