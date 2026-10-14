import { describe, expect, it, vi } from "vitest";
import { createDeliveryCoordinator } from "./coordinator.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import {
  captureInput,
  sendOneAtATime,
  temporaryRoot,
} from "../../test-support/tracing/delivery.js";

const retry = {
  integration: "claude-code",
  sessionId: "session-1",
  turnId: "turn-1",
  eventId: "event",
};

function coordinatorFor(root: string, policy = {}) {
  return createDeliveryCoordinator({
    storageRoot: root,
    integration: "claude-code",
    sessionId: "session-1",
    policy: { quickRetryMs: 0, ...policy },
  });
}

const writer = (send: (record: { eventId: string }) => Promise<void>) => ({
  writer: {
    accountFingerprint: "account-a",
    destinations: [{ id: "primary" }],
    ...sendOneAtATime(send),
  },
});

function flaky(
  failures: number,
  error: Error = new Error("transport failed"),
): { state: { sends: number }; transport: ReturnType<typeof writer> } {
  const state = { sends: 0 };
  return {
    state,
    transport: writer(async () => {
      state.sends += 1;
      if (state.sends <= failures) throw error;
    }),
  };
}

const inTurn = (turnId: string, eventId: string, dependsOn?: string) => ({
  ...captureInput(eventId, `run-${eventId}`),
  turnId,
  ...(dependsOn === undefined
    ? {}
    : {
        dependencies: [
          {
            integration: "claude-code",
            sessionId: "session-1",
            turnId: "turn-a",
            eventId: dependsOn,
          },
        ],
      }),
});

async function openWith(policy: object) {
  const root = temporaryRoot();
  const coordinator = coordinatorFor(root, policy);
  await coordinator.capture(captureInput("event", "run-1"));
  return { root, coordinator };
}

describe("delivery limits and retries", () => {
  it("drops whole oldest turns beyond the entry limit, with their dependents, warns and removes them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = temporaryRoot();
    const coordinator = coordinatorFor(root, { maxEntries: 3 });
    for (const input of [
      inTurn("turn-a", "a1"),
      inTurn("turn-a", "a2"),
      inTurn("turn-b", "b1", "a1"),
      inTurn("turn-c", "c1"),
      inTurn("turn-c", "c2"),
    ])
      await coordinator.capture(input);
    const sent: string[] = [];
    const result = await coordinator.drain(
      writer(async (record) => {
        sent.push(record.eventId);
      }),
    );
    expect(result).toMatchObject({ status: "drained", delivered: 2, dropped: 3, pending: 0 });
    expect(sent.toSorted()).toEqual(["c1", "c2"]);
    const left = await createCaptureStore(root).enumerate("claude-code", "session-1");
    expect(left.map(({ record }) => record.eventId).toSorted()).toEqual(["c1", "c2"]);
    expect(String(warn.mock.calls[0]?.join(" "))).toContain("capacity");
    warn.mockRestore();
  });

  it("drops a single turn that is over the limit, warning about the capacity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = temporaryRoot();
    const coordinator = coordinatorFor(root, { maxEntries: 1 });
    for (const id of ["x1", "x2", "x3"]) await coordinator.capture(captureInput(id, `run-${id}`));
    await expect(coordinator.drain(writer(async () => undefined))).resolves.toMatchObject({
      delivered: 0,
      dropped: 3,
    });
    expect(String(warn.mock.calls[0]?.join(" "))).toContain("capacity");
    warn.mockRestore();
  });

  it("keeps failing work and waits longer after every failure", async () => {
    const root = temporaryRoot();
    const coordinator = coordinatorFor(root);
    await coordinator.capture(captureInput("event", "run-1"));
    let sends = 0;
    const failing = writer(async () => {
      sends += 1;
      throw new Error("transport failed");
    });
    const clock = vi.spyOn(Date, "now");
    const store = createCaptureStore(root);
    let now = 1_800_000_000_000;
    const waits: number[] = [];
    for (const step of [0, 1_000, 6_000, 20_000]) {
      clock.mockReturnValue(now + step);
      await coordinator.drain(failing);
      const saved = (await store.read(retry))!.delivery!.retries["primary"]!;
      waits.push(saved.notBeforeMs - (now + step));
    }
    expect(sends).toBe(3);
    expect(waits).toEqual([5_000, 4_000, 10_000, 20_000]);
    clock.mockRestore();
    await expect(store.read(retry)).resolves.toBeDefined();
  });

  it("retries work stranded by an earlier process without waiting for its backoff", async () => {
    const root = temporaryRoot();
    const coordinator = coordinatorFor(root);
    await coordinator.capture(captureInput("event", "run-1"));
    const store = createCaptureStore(root);
    await store.recordRetry(retry, "primary", {
      failures: 6,
      recordedAtMs: 1,
      notBeforeMs: Date.now() + 3_600_000,
    });
    let sends = 0;
    await expect(
      coordinator.drain(
        writer(async () => {
          sends += 1;
        }),
      ),
    ).resolves.toMatchObject({ delivered: 1 });
    expect(sends).toBe(1);
  });

  it("still waits out a backoff recorded by this process", async () => {
    const root = temporaryRoot();
    const coordinator = coordinatorFor(root);
    await coordinator.capture(captureInput("event", "run-1"));
    await createCaptureStore(root).recordRetry(retry, "primary", {
      failures: 6,
      recordedAtMs: Date.now(),
      notBeforeMs: Date.now() + 3_600_000,
    });
    let sends = 0;
    await coordinator.drain(
      writer(async () => {
        sends += 1;
      }),
    );
    expect(sends).toBe(0);
  });

  it("writes nothing before a send so an interrupted send costs nothing", async () => {
    const root = temporaryRoot();
    const coordinator = coordinatorFor(root);
    await coordinator.capture(captureInput("event", "run-1"));
    const seen: unknown[] = [];
    await coordinator.drain(
      writer(async () => {
        seen.push((await createCaptureStore(root).read(retry))?.delivery);
      }),
    );
    expect(seen).toEqual([undefined]);
  });

  it("drops work the service rejects for good right away and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = temporaryRoot();
    const coordinator = coordinatorFor(root);
    await coordinator.capture(captureInput("event", "run-1"));
    const rejected = writer(async () => {
      throw Object.assign(new Error("bad request"), { retryable: false });
    });
    await expect(coordinator.drain(rejected)).resolves.toMatchObject({
      status: "drained",
      failed: 1,
      dropped: 1,
      pending: 0,
    });
    await expect(createCaptureStore(root).read(retry)).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]?.join(" "))).toContain("rejected");
    expect(String(warn.mock.calls[0]?.join(" "))).toContain("for run run-1 on destination primary");
    warn.mockRestore();
  });

  it.each([
    [401, true],
    [403, true],
    [400, false],
    [413, false],
  ])("names HTTP %i in the warning for rejected work", async (status, hint) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { coordinator } = await openWith({});
    await coordinator.drain(
      writer(async () => {
        throw Object.assign(new Error("rejected"), { retryable: false, status });
      }),
    );
    const message = String(warn.mock.calls[0]?.join(" "));
    expect(message).toContain(`HTTP ${status}`);
    expect(message.includes("API key")).toBe(hint);
    warn.mockRestore();
  });

  describe("trying a failed send again right away", () => {
    it("delivers work whose first send failed and second one worked, leaving no retry record", async () => {
      const { root, coordinator } = await openWith({ quickRetryMs: 5 });
      const { state, transport } = flaky(1);
      await expect(coordinator.drain(transport)).resolves.toMatchObject({
        delivered: 1,
        failed: 0,
        pending: 0,
      });
      expect(state.sends).toBe(2);
      const saved = await createCaptureStore(root).read(retry);
      expect(saved?.delivery).toEqual({
        retries: {},
        outcomes: { primary: expect.objectContaining({ outcome: "delivered" }) },
      });
    });

    it("gives up after the one extra send and keeps the work for the backoff", async () => {
      const { root, coordinator } = await openWith({ quickRetryMs: 5 });
      const { state, transport } = flaky(Infinity);
      await expect(coordinator.drain(transport)).resolves.toMatchObject({ failed: 1, pending: 1 });
      expect(state.sends).toBe(2);
      const saved = await createCaptureStore(root).read(retry);
      expect(saved?.delivery?.retries["primary"]?.failures).toBe(1);
    });

    it("sends only once per pass after the first failure", async () => {
      const { coordinator } = await openWith({ quickRetryMs: 5 });
      const { state, transport } = flaky(Infinity);
      await coordinator.drain(transport);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      await coordinator.drain(transport);
      clock.mockRestore();
      expect(state.sends).toBe(3);
    });

    it("does not send again work the service rejects for good", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { coordinator } = await openWith({ quickRetryMs: 5 });
      const { state, transport } = flaky(
        Infinity,
        Object.assign(new Error("bad"), { retryable: false }),
      );
      await coordinator.drain(transport);
      expect(state.sends).toBe(1);
      warn.mockRestore();
    });

    it("waits the configured time between the two sends and can be switched off", async () => {
      const waited = await openWith({ quickRetryMs: 120 });
      const slow = flaky(1);
      const started = performance.now();
      await waited.coordinator.drain(slow.transport);
      expect(performance.now() - started).toBeGreaterThanOrEqual(100);
      const off = await openWith({ quickRetryMs: 0 });
      const once = flaky(Infinity);
      await off.coordinator.drain(once.transport);
      expect(once.state.sends).toBe(1);
    });
  });

  it.each([{ maxAgeMs: 0 }, { quickRetryMs: -1 }, { quickRetryMs: 1.5 }])(
    "refuses the invalid limit %j",
    (policy) => {
      expect(() => coordinatorFor(temporaryRoot(), policy)).toThrow("Invalid delivery policy");
    },
  );
});
