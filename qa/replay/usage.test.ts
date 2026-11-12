import { describe, expect, it } from "vitest";
import { usageSummary } from "./usage.ts";

describe("usageSummary", () => {
  it("reports the nearest-rank p50, p95 and p99 across sessions", () => {
    const usages = Array.from({ length: 100 }, (_, index) => ({
      cpuMs: 100 - index,
      peakMemoryBytes: (index + 1) * 1024 * 1024,
      exitedOnItsOwn: true,
    }));
    expect(usageSummary(usages)).toBe(
      "100 sessions, CPU ms p50 50, p95 95, p99 99, peak memory MB p50 50, p95 95, p99 99",
    );
  });
});
