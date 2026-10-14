import { setTimeout as delay } from "node:timers/promises";

export async function waitFor<T>(predicate: () => T | false, what = "test state"): Promise<T> {
  for (const deadline = Date.now() + 8_000; Date.now() < deadline; await delay(5)) {
    const value = predicate();
    if (value) return value;
  }
  throw new Error(`Timed out waiting for ${what}`);
}
