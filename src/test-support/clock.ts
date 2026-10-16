import { vi } from "vitest";
import { QUIET_TURN_MS } from "./constants.js";

export async function afterQuiet<T>(action: () => Promise<T>): Promise<T> {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + QUIET_TURN_MS);
  try {
    return await action();
  } finally {
    clock.mockRestore();
  }
}
