import { describe, expect, it, vi } from "vitest";
import { snapshotData } from "./snapshot.js";

describe("safe data snapshots", () => {
  it("preserves explicitly undefined fields", () => {
    const snapshot = snapshotData({ start_time: undefined });

    expect(Object.hasOwn(snapshot, "start_time")).toBe(true);
    expect(snapshot.start_time).toBeUndefined();
  });

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => "private");
    const input = Object.defineProperty({}, "value", { enumerable: true, get: getter });

    expect(() => snapshotData(input)).toThrow("Snapshot input must use data properties");
    expect(getter).not.toHaveBeenCalled();
  });
});
