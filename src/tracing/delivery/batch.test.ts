import { describe, expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/capture-store.js";
import type { StoredCapture } from "../../storage/capture/models.js";
import { captureInput, temporaryRoot } from "../../test-support/tracing/delivery.js";
import { createDeliveryCoordinator } from "./coordinator.js";
import type { DeliveryBatchLimits } from "./models.js";

const SESSION = { integration: "claude-code", sessionId: "session-1", turnId: "turn-1" };
const NO_BACKOFF = { retryBaseMs: 0, quickRetryMs: 0 };

function setup() {
  const root = temporaryRoot();
  const coordinator = createDeliveryCoordinator({
    storageRoot: root,
    integration: "claude-code",
    sessionId: "session-1",
    policy: NO_BACKOFF,
  });
  return { root, coordinator };
}

function writerWith(
  sendBatch: (records: readonly StoredCapture[]) => Promise<void>,
  extra: { batchLimits?: DeliveryBatchLimits } = {},
) {
  return {
    accountFingerprint: "account-a",
    destinations: [{ id: "primary" }],
    sendBatch,
    batchLimits: { maxRecords: 100, maxBytes: 1_000_000 },
    ...extra,
  };
}

const events = (calls: readonly (readonly StoredCapture[])[]) =>
  calls.map((records) => records.map(({ eventId }) => eventId));

describe("delivering ready work in batches", () => {
  it("sends independent and dependent records in one batch, prerequisites first", async () => {
    const { coordinator } = setup();
    await coordinator.capture({ ...captureInput("a-root", "run-root"), eventKind: "run-post" });
    await coordinator.capture({
      ...captureInput("b-child", "run-child"),
      eventKind: "run-post",
      dependencies: [{ ...SESSION, eventId: "a-root" }],
    });
    await coordinator.capture({ ...captureInput("c-other", "run-other"), eventKind: "run-post" });
    const calls: StoredCapture[][] = [];
    const writer = writerWith(async (records) => void calls.push([...records]));
    await expect(coordinator.drain({ writer })).resolves.toMatchObject({
      delivered: 3,
      pending: 0,
    });
    expect(events(calls)).toEqual([["a-root", "b-child", "c-other"]]);
  });

  it("keeps a run's second event for the next batch", async () => {
    const { coordinator } = setup();
    await coordinator.capture({ ...captureInput("first", "run-1"), eventKind: "run-patch" });
    await coordinator.capture({ ...captureInput("second", "run-1"), eventKind: "run-patch" });
    const calls: StoredCapture[][] = [];
    const writer = writerWith(async (records) => void calls.push([...records]));
    await expect(coordinator.drain({ writer })).resolves.toMatchObject({ delivered: 2 });
    expect(events(calls)).toEqual([["first"], ["second"]]);
  });

  it("splits a drain at the record limit", async () => {
    const { coordinator } = setup();
    for (const id of ["a", "b", "c"])
      await coordinator.capture({ ...captureInput(id, `run-${id}`), eventKind: "run-post" });
    const calls: StoredCapture[][] = [];
    const record = (limits: DeliveryBatchLimits) =>
      writerWith(async (records) => void calls.push([...records]), { batchLimits: limits });
    await coordinator.drain({ writer: record({ maxRecords: 2, maxBytes: 1_000_000 }) });
    expect(events(calls)).toEqual([["a", "b"], ["c"]]);
  });

  it("keeps every record of a failed batch pending with its own retry", async () => {
    const { root, coordinator } = setup();
    for (const id of ["a", "b", "c"])
      await coordinator.capture({ ...captureInput(id, `run-${id}`), eventKind: "run-post" });
    const failing = writerWith(async () => {
      throw Object.assign(new Error("unavailable"), { retryable: true, status: 503 });
    });
    await expect(coordinator.drain({ writer: failing })).resolves.toMatchObject({
      delivered: 0,
      dropped: 0,
      failed: 3,
      pending: 3,
    });
    const stored = await createCaptureStore(root).enumerate("claude-code", "session-1");
    expect(stored.map(({ record }) => record.delivery?.retries["primary"]?.failures)).toEqual([
      1, 1, 1,
    ]);
    const calls: StoredCapture[][] = [];
    await expect(
      coordinator.drain({ writer: writerWith(async (records) => void calls.push([...records])) }),
    ).resolves.toMatchObject({ delivered: 3, pending: 0 });
    expect(events(calls)).toEqual([["a", "b", "c"]]);
  });

  it("sends a rejected batch one record at a time so only the bad record is dropped", async () => {
    const { coordinator } = setup();
    for (const id of ["a", "b", "c"])
      await coordinator.capture({ ...captureInput(id, `run-${id}`), eventKind: "run-post" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: StoredCapture[][] = [];
    const writer = writerWith(async (records) => {
      calls.push([...records]);
      if (records.some(({ eventId }) => eventId === "b"))
        throw Object.assign(new Error("rejected"), { retryable: false, status: 400 });
    });
    try {
      await expect(coordinator.drain({ writer })).resolves.toMatchObject({
        delivered: 2,
        dropped: 1,
        pending: 0,
      });
    } finally {
      warn.mockRestore();
    }
    expect(events(calls)).toEqual([["a", "b", "c"], ["a"], ["b"], ["c"]]);
  });

  it("does not send a record whose prerequisite was in a batch that failed", async () => {
    const { coordinator } = setup();
    await coordinator.capture({ ...captureInput("a-first", "run-1"), eventKind: "run-post" });
    await coordinator.capture({
      ...captureInput("b-next", "run-2"),
      eventKind: "run-post",
      dependencies: [{ ...SESSION, eventId: "a-first" }],
    });
    const calls: StoredCapture[][] = [];
    const writer = writerWith(
      async (records) => {
        calls.push([...records]);
        throw Object.assign(new Error("unavailable"), { retryable: true, status: 503 });
      },
      { batchLimits: { maxRecords: 1, maxBytes: 1_000_000 } },
    );
    await expect(coordinator.drain({ writer })).resolves.toMatchObject({
      delivered: 0,
      failed: 1,
      pending: 2,
    });
    expect(events(calls)).toEqual([["a-first"]]);
  });

  it("counts bytes, not characters, against the byte limit", async () => {
    const { coordinator } = setup();
    for (const id of ["a", "b"])
      await coordinator.capture({
        ...captureInput(id, `run-${id}`),
        eventKind: "run-post",
        normalizedPayload: { text: "é".repeat(600) },
      });
    const calls: StoredCapture[][] = [];
    const writer = writerWith(async (records) => void calls.push([...records]), {
      batchLimits: { maxRecords: 100, maxBytes: 1_500 },
    });
    await coordinator.drain({ writer });
    expect(events(calls)).toEqual([["a"], ["b"]]);
  });

  describe("when a rejected batch is sent one record at a time", () => {
    it("drops a child with the parent the service rejected", async () => {
      const { result, calls } = await drainParentAndChild(
        Object.assign(new Error("rejected"), { retryable: false, status: 400 }),
      );
      expect(result).toMatchObject({ delivered: 0, dropped: 2, pending: 0 });
      expect(events(calls)).toEqual([["a-parent", "b-child"], ["a-parent"]]);
    });

    it("keeps a child pending while its parent is waiting for a retry", async () => {
      const { result, calls } = await drainParentAndChild(
        Object.assign(new Error("unavailable"), { retryable: true, status: 503 }),
      );
      expect(result).toMatchObject({ delivered: 0, dropped: 0, pending: 2 });
      expect(events(calls)).toEqual([["a-parent", "b-child"], ["a-parent"]]);
    });
  });
});

async function drainParentAndChild(parentFailure: Error | undefined) {
  const { coordinator } = setup();
  await coordinator.capture({ ...captureInput("a-parent", "run-1"), eventKind: "run-post" });
  await coordinator.capture({
    ...captureInput("b-child", "run-2"),
    eventKind: "run-post",
    dependencies: [{ ...SESSION, eventId: "a-parent" }],
  });
  const calls: StoredCapture[][] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const writer = writerWith(async (records) => {
    calls.push([...records]);
    if (records.length > 1)
      throw Object.assign(new Error("rejected"), { retryable: false, status: 400 });
    if (records[0]?.eventId === "a-parent" && parentFailure !== undefined) throw parentFailure;
  });
  try {
    const result = await coordinator.drain({ writer });
    return { result, calls };
  } finally {
    warn.mockRestore();
  }
}
