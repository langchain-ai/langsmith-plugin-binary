import { describe, expect, it, vi } from "vitest";
import { createDeliveryCoordinator } from "./coordinator.js";
import * as captureStoreModule from "../../storage/capture/index.js";
import { createCaptureStore } from "../../storage/capture/capture-store.js";
import {
  captureInput,
  sendOneAtATime,
  temporaryRoot,
} from "../../test-support/tracing/delivery.js";

describe("delivery dependencies", () => {
  it("defers full-scope dependencies until the prerequisite is delivered", async () => {
    const root = temporaryRoot();
    const parent = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "parent-session",
    });
    const child = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "child-session",
    });
    const prerequisite = {
      integration: "claude-code",
      sessionId: "parent-session",
      turnId: "parent-turn",
      eventId: "parent-event",
    };
    await child.capture({
      ...captureInput("child-event", "child-run"),
      turnId: "child-turn",
      dependencies: [prerequisite],
    });
    const order: string[] = [];
    const writer = {
      accountFingerprint: "account-a",
      destinations: [{ id: "primary" }],
      ...sendOneAtATime(async (record: { eventId: string }) => {
        order.push(record.eventId);
      }),
    };
    await expect(child.drain({ writer })).resolves.toMatchObject({ status: "drained", pending: 1 });
    await parent.capture({
      ...captureInput("parent-event", "parent-run"),
      turnId: "parent-turn",
    });
    await expect(child.drain({ writer })).resolves.toMatchObject({ status: "drained", pending: 1 });
    await parent.drain({ writer });
    await expect(child.drain({ writer })).resolves.toMatchObject({
      status: "drained",
      delivered: 1,
      pending: 0,
    });
    expect(order).toEqual(["parent-event", "child-event"]);
  });

  it("sends same-turn dependents after prerequisites even when they sort first", async () => {
    const coordinator = createDeliveryCoordinator({
      storageRoot: temporaryRoot(),
      integration: "claude-code",
      sessionId: "session-1",
    });
    await coordinator.capture({
      ...captureInput("a-patch", "run-1"),
      eventKind: "run-patch",
      dependencies: [
        {
          integration: "claude-code",
          sessionId: "session-1",
          turnId: "turn-1",
          eventId: "z-post",
        },
      ],
    });
    await coordinator.capture({
      ...captureInput("z-post", "run-1"),
      eventKind: "run-post",
    });
    const sent: string[] = [];
    const result = await coordinator.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations: [{ id: "primary" }],
        ...sendOneAtATime(async (record) => {
          sent.push(record.eventId);
        }),
      },
    });
    expect(result).toMatchObject({ status: "drained", delivered: 2, pending: 0 });
    expect(sent).toEqual(["z-post", "a-patch"]);
  });

  it("reads each reverse-chain dependency receipt once per drain", async () => {
    const originalCreateCaptureStore = captureStoreModule.createCaptureStore;
    const createStoreSpy = vi.spyOn(captureStoreModule, "createCaptureStore");
    let captureReads = 0;
    let receiptReads = 0;
    createStoreSpy.mockImplementation((root) => {
      const store = originalCreateCaptureStore(root);
      const read = store.read.bind(store);
      const readOutcome = store.readOutcome.bind(store);
      vi.spyOn(store, "read").mockImplementation(async (captureScope) => {
        captureReads += 1;
        return read(captureScope);
      });
      vi.spyOn(store, "readOutcome").mockImplementation(async (outcomeScope, destination) => {
        receiptReads += 1;
        return readOutcome(outcomeScope, destination);
      });
      return store;
    });
    try {
      const size = 6;
      const coordinator = createDeliveryCoordinator({
        storageRoot: temporaryRoot(),
        integration: "claude-code",
        sessionId: "session-1",
      });
      for (let index = 0; index < size; index += 1) {
        const eventId = `event-${String(index).padStart(2, "0")}`;
        const next = `event-${String(index + 1).padStart(2, "0")}`;
        await coordinator.capture({
          ...captureInput(eventId, eventId),
          ...(index + 1 < size
            ? {
                dependencies: [
                  {
                    integration: "claude-code",
                    sessionId: "session-1",
                    turnId: "turn-1",
                    eventId: next,
                  },
                ],
              }
            : {}),
        });
      }
      captureReads = 0;
      receiptReads = 0;
      const sent: string[] = [];
      const result = await coordinator.drain({
        writer: {
          accountFingerprint: "account-a",
          destinations: [{ id: "primary" }],
          ...sendOneAtATime(async (record) => {
            sent.push(record.eventId);
          }),
        },
      });
      expect(result).toMatchObject({ status: "drained", delivered: size, pending: 0 });
      expect(sent).toEqual(
        Array.from(
          { length: size },
          (_, index) => `event-${String(size - 1 - index).padStart(2, "0")}`,
        ),
      );
      expect(receiptReads).toBe(size);
      expect(captureReads).toBeLessThanOrEqual(size * 2);
    } finally {
      createStoreSpy.mockRestore();
    }
  });

  it("drops a dependent whose prerequisite was dropped and removes the dropped work", async () => {
    const root = temporaryRoot();
    const child = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "child-session",
    });
    const prerequisite = {
      integration: "claude-code",
      sessionId: "parent-session",
      turnId: "parent-turn",
      eventId: "parent-event",
    };
    const store = createCaptureStore(root);
    const parentInput = {
      ...captureInput(prerequisite.eventId, "parent-run"),
      integration: "claude-code",
      sessionId: prerequisite.sessionId,
      turnId: prerequisite.turnId,
    };
    await expect(store.capture(parentInput)).resolves.toMatchObject({ status: "published" });
    await child.capture({
      ...captureInput("child-event", "child-run"),
      turnId: "child-turn",
      dependencies: [prerequisite],
    });
    await expect(
      store.recordOutcome({ ...prerequisite, destination: "primary", outcome: "dropped" }),
    ).resolves.toMatchObject({ status: "recorded" });
    let sends = 0;
    const result = await child.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations: [{ id: "primary" }],
        ...sendOneAtATime(async () => {
          sends += 1;
        }),
      },
    });
    expect(result).toMatchObject({ status: "drained", dropped: 1, pending: 0 });
    expect(sends).toBe(0);
    await expect(store.enumerate("claude-code", "child-session")).resolves.toEqual([]);
  });

  it("does not trust a prerequisite receipt from a different account", async () => {
    const root = temporaryRoot();
    const child = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "child-session",
    });
    const prerequisite = {
      integration: "claude-code",
      sessionId: "parent-session",
      turnId: "parent-turn",
      eventId: "parent-event",
    };
    const store = createCaptureStore(root);
    await expect(
      store.capture({
        ...captureInput(prerequisite.eventId, "parent-run"),
        integration: "claude-code",
        sessionId: prerequisite.sessionId,
        turnId: prerequisite.turnId,
        destinationFingerprint: "account-b",
      }),
    ).resolves.toMatchObject({ status: "published" });
    await child.capture({
      ...captureInput("child-event", "child-run"),
      turnId: "child-turn",
      dependencies: [prerequisite],
    });
    await expect(
      store.recordOutcome({ ...prerequisite, destination: "primary", outcome: "delivered" }),
    ).resolves.toMatchObject({ status: "recorded" });
    let sends = 0;
    const result = await child.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations: [{ id: "primary" }],
        ...sendOneAtATime(async () => {
          sends += 1;
        }),
      },
    });
    expect(result).toMatchObject({ status: "drained", pending: 1 });
    expect(sends).toBe(0);
    await expect(
      store.readOutcome(
        {
          integration: "claude-code",
          sessionId: "child-session",
          turnId: "child-turn",
          eventId: "child-event",
        },
        "primary",
      ),
    ).resolves.toEqual({ status: "pending" });
  });

  it("keeps a dependent waiting for a prerequisite that has not been captured yet", async () => {
    const coordinator = createDeliveryCoordinator({
      storageRoot: temporaryRoot(),
      integration: "claude-code",
      sessionId: "session-1",
    });
    await coordinator.capture({
      ...captureInput("end", "run-1"),
      dependencies: [
        { integration: "claude-code", sessionId: "session-1", turnId: "turn-1", eventId: "start" },
      ],
    });
    const sent: string[] = [];
    const writer = {
      accountFingerprint: "account-a",
      destinations: [{ id: "primary" }],
      ...sendOneAtATime(async (record) => void sent.push(record.eventId)),
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3_600_000);
      await expect(coordinator.drain({ writer })).resolves.toMatchObject({
        delivered: 0,
        pending: 1,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(sent).toEqual([]);
  });

  it("drops a dependent captured after its prerequisite was rejected and removed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const coordinator = createDeliveryCoordinator({
      storageRoot: temporaryRoot(),
      integration: "claude-code",
      sessionId: "session-1",
      policy: { quickRetryMs: 0 },
    });
    await coordinator.capture(captureInput("start", "run-1"));
    const sent: string[] = [];
    const writer = {
      accountFingerprint: "account-a",
      destinations: [{ id: "primary" }],
      ...sendOneAtATime(async (record) => {
        sent.push(record.eventId);
        if (record.eventId === "start")
          throw Object.assign(new Error("rejected"), { retryable: false, status: 400 });
      }),
    };
    await expect(coordinator.drain({ writer })).resolves.toMatchObject({ dropped: 1 });
    await coordinator.capture({
      ...captureInput("end", "run-1"),
      dependencies: [
        { integration: "claude-code", sessionId: "session-1", turnId: "turn-1", eventId: "start" },
      ],
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3_600_000);
      await expect(coordinator.drain({ writer })).resolves.toMatchObject({
        delivered: 0,
        dropped: 1,
        pending: 0,
      });
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
    expect(sent).toEqual(["start"]);
  });
});
