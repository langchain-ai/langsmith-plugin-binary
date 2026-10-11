import { describe, expect, it } from "vitest";
import { createDeliveryCoordinator } from "./coordinator.js";
import type { DrainOptions } from "./models.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import { captureInput, scope, temporaryRoot } from "../../test-support/tracing/delivery.js";

describe("delivery retention limits", () => {
  it("records an explicit capacity drop and retains every captured event", async () => {
    const root = temporaryRoot();
    const coordinator = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
    });
    for (let index = 0; index < 501; index += 1) {
      const id = String(index).padStart(3, "0");
      const captured = await coordinator.capture(captureInput(`event-${id}`, `run-${id}`));
      expect(captured.status).toBe("published");
    }
    const result = await coordinator.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations: [{ id: "primary" }],
        send: async () => undefined,
      },
    });
    const store = createCaptureStore(root);
    const captures = await store.enumerate("claude-code", "session-1");
    const outcomes = await Promise.all(
      captures.map(({ record }) => store.readOutcome(scope(record), "primary")),
    );
    expect(result).toMatchObject({ status: "drained", delivered: 500, dropped: 1, pending: 0 });
    expect(captures).toHaveLength(501);
    expect(
      outcomes.filter(
        (outcome) => outcome.status === "settled" && outcome.receipt.outcome === "dropped",
      ),
    ).toHaveLength(1);
    expect(outcomes.every((outcome) => outcome.status === "settled")).toBe(true);
    await expect(
      store.read({
        integration: "claude-code",
        sessionId: "session-1",
        turnId: "turn-1",
        eventId: "event-000",
      }),
    ).resolves.toBeDefined();
  }, 60_000);

  it("marks expired and exhausted work dropped without removing its capture", async () => {
    const root = temporaryRoot();
    const coordinator = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
      policy: { maxAttempts: 2, maxAgeMs: 60_000 },
    });
    const expiredInput = captureInput("expired", "run-expired");
    const retryInput = captureInput("retry", "run-retry");
    await coordinator.capture(expiredInput);
    const enumerated = await createCaptureStore(root).enumerate("claude-code", "session-1");
    const expiredTime = Math.ceil(
      enumerated.find(({ record }) => record.eventId === "expired")!.capturedAtMs + 60_000,
    );
    const expiredResult = await coordinator.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations: [{ id: "primary" }],
        send: async () => {
          throw new Error("expired event was sent");
        },
      },
      now: expiredTime,
    });
    expect(expiredResult).toMatchObject({ status: "drained", dropped: 1, failed: 0 });
    await coordinator.capture(retryInput);
    let sends = 0;
    const retryOptions: DrainOptions = {
      writer: {
        accountFingerprint: "account-a",
        destinations: [{ id: "primary" }],
        send: async (record) => {
          if (record.eventId === "retry") {
            sends += 1;
            throw new Error("transport failed");
          }
        },
      },
    };
    await coordinator.drain(retryOptions);
    const exhausted = await coordinator.drain(retryOptions);
    const store = createCaptureStore(root);
    expect(sends).toBe(2);
    expect(exhausted).toMatchObject({ status: "drained", dropped: 1, pending: 0 });
    await expect(
      store.readOutcome(
        {
          integration: "claude-code",
          sessionId: "session-1",
          turnId: "turn-1",
          eventId: "expired",
        },
        "primary",
      ),
    ).resolves.toMatchObject({
      status: "settled",
      receipt: { outcome: "dropped", reason: "expired" },
    });
    await expect(
      store.readOutcome(
        {
          integration: "claude-code",
          sessionId: "session-1",
          turnId: "turn-1",
          eventId: "retry",
        },
        "primary",
      ),
    ).resolves.toMatchObject({
      status: "settled",
      receipt: { outcome: "dropped", reason: "retry-exhausted" },
    });
    await expect(
      store.read({
        integration: "claude-code",
        sessionId: "session-1",
        turnId: "turn-1",
        eventId: "retry",
      }),
    ).resolves.toBeDefined();
  });
});
