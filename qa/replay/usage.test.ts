import { describe, expect, it } from "vitest";
import { usageLine, usageSummary, usagesFromLog } from "./usage.ts";

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

  it("summarizes the usage lines read back from several replay logs", () => {
    const first = [
      usageLine("a.jsonl", {
        cpuMs: 1200,
        peakMemoryBytes: 64.5 * 1024 * 1024,
        exitedOnItsOwn: true,
      }),
      "PASS a.jsonl",
    ].join("\n");
    const second = `SKIP b.jsonl (no user turns)\n${usageLine("c.jsonl", { cpuMs: 800, peakMemoryBytes: 50 * 1024 * 1024, exitedOnItsOwn: false })}\n`;
    expect(usageSummary([...usagesFromLog(first), ...usagesFromLog(second)])).toBe(
      "2 sessions, CPU ms p50 800, p95 1200, p99 1200, peak memory MB p50 50, p95 64.5, p99 64.5",
    );
  });
});
