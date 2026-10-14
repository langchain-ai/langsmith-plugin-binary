import { afterEach, expect, it, vi } from "vitest";
import { drainThroughBackoff } from "./retry-wait.js";

const { delays } = vi.hoisted(() => ({ delays: [] as number[] }));

vi.mock("node:timers/promises", () => ({
  setTimeout: async (ms: number) => {
    delays.push(ms);
  },
}));

afterEach(() => {
  delays.length = 0;
  vi.restoreAllMocks();
});

const waiting = (inMs: number) =>
  ({ status: "drained", pending: 1, nextRetryAtMs: Date.now() + inMs }) as const;

it("waits for the earliest retry time and drains again", async () => {
  const drain = vi
    .fn()
    .mockResolvedValueOnce(waiting(5_000))
    .mockResolvedValueOnce({ status: "drained", pending: 0 });
  await expect(drainThroughBackoff(drain)).resolves.toEqual({ status: "drained", pending: 0 });
  expect(drain).toHaveBeenCalledTimes(2);
  expect(delays).toHaveLength(1);
  expect(delays[0]).toBeGreaterThan(4_000);
});

it("does not wait for a retry time beyond the cap", async () => {
  const drain = vi.fn().mockResolvedValue(waiting(10 * 60 * 1000));
  await drainThroughBackoff(drain);
  expect(drain).toHaveBeenCalledTimes(1);
  expect(delays).toEqual([]);
});

it("stops after a fixed number of passes", async () => {
  let tick = 0;
  const drain = vi.fn(async () => ({
    ...waiting(1_000),
    nextRetryAtMs: Date.now() + 1_000 + ++tick,
  }));
  await drainThroughBackoff(drain);
  expect(drain).toHaveBeenCalledTimes(9);
});

it("stops when a pass leaves the retry time unchanged", async () => {
  const drain = vi.fn().mockResolvedValue({ status: "drained", pending: 1, nextRetryAtMs: 1 });
  await drainThroughBackoff(drain);
  expect(drain).toHaveBeenCalledTimes(2);
});

it("does not wait when nothing is pending or a drain is busy", async () => {
  const drain = vi.fn().mockResolvedValue({ status: "busy" });
  await drainThroughBackoff(drain);
  await drainThroughBackoff(vi.fn().mockResolvedValue({ status: "drained", pending: 0 }));
  expect(delays).toEqual([]);
});
