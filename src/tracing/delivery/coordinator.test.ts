import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createDeliveryCoordinator } from "./coordinator.js";
import type { DeliveryCaptureInput, DeliveryWriter, DrainOptions } from "./models.js";
import * as captureStoreModule from "../../storage/capture/index.js";
import { createCaptureStore } from "../../storage/capture/capture-store.js";
import type { CaptureScope } from "../../storage/capture/models.js";

const execFileAsync = promisify(execFile);

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "plugins base delivery "));
}

function captureInput(eventId = "event-1", runId = "run-1"): DeliveryCaptureInput {
  return {
    turnId: "turn-1",
    eventId,
    runId,
    destinationFingerprint: "account-a",
    eventKind: "tool-result",
    normalizedPayload: { id: eventId },
    turnEvidence: { childRunIds: [runId], closed: false },
    metadataProvenance: { producer: "test" },
  };
}

function moduleUrl(relativePath: string): string {
  return pathToFileURL(join(process.cwd(), relativePath)).href;
}

function childEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    SystemRoot: process.env.SystemRoot,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    CI: "1",
  };
}

function scope(record: CaptureScope): CaptureScope {
  return {
    integration: record.integration,
    sessionId: record.sessionId,
    turnId: record.turnId,
    eventId: record.eventId,
  };
}

function errorCode(error: unknown): number | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined;
}

describe("durable delivery coordinator", () => {
  it("replays the same run ID after a process dies after transport acceptance", async () => {
    const root = temporaryRoot();
    const home = mkdtempSync(join(tmpdir(), "plugins-base-delivery-home-"));
    const coordinator = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
    });
    const input = captureInput();
    await expect(coordinator.capture(input)).resolves.toMatchObject({ status: "published" });
    const marker = join(root, "accepted-run-id");
    const url = moduleUrl("dist/tracing/delivery/index.js");
    const script = `const {createDeliveryCoordinator}=await import(${JSON.stringify(url)});const {writeFileSync}=await import("node:fs");const c=createDeliveryCoordinator({storageRoot:process.argv[1],integration:"claude-code",sessionId:"session-1"});await c.drain({writer:{accountFingerprint:"account-a",destinations:[{id:"primary"}],send:async record=>{writeFileSync(process.argv[2],record.runId);process.exit(71)}}});`;
    const childCode = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script, root, marker],
      { env: childEnvironment(home), timeout: 10_000 },
    )
      .then(() => 0)
      .catch(errorCode);
    expect(childCode).toBe(71);
    const acceptedRunId = readFileSync(marker, "utf8");
    const replayed: string[] = [];
    const resumed = await coordinator.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations: [{ id: "primary" }],
        send: async (record) => {
          replayed.push(record.runId);
        },
      },
    });
    expect(acceptedRunId).toBe(input.runId);
    expect(replayed).toEqual([input.runId]);
    expect(resumed).toMatchObject({ status: "drained", delivered: 1, pending: 0 });
    await expect(
      createCaptureStore(root).read({
        integration: "claude-code",
        sessionId: "session-1",
        turnId: input.turnId,
        eventId: input.eventId,
      }),
    ).resolves.toMatchObject({ runId: input.runId });
  }, 20_000);

  it("keeps destination acknowledgements independent across retries", async () => {
    const root = temporaryRoot();
    const coordinator = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
    });
    const input = {
      ...captureInput(),
      normalizedPayload: { nested: { value: "original" } },
    };
    await coordinator.capture(input);
    const sent: string[] = [];
    const destinations = [{ id: "primary" }, { id: "replica" }];
    const first = await coordinator.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations,
        send: async (record, destination) => {
          const payload = record.normalizedPayload as typeof input.normalizedPayload;
          sent.push(`${destination.id}:${payload.nested.value}`);
          if (destination.id === "primary") payload.nested.value = "changed";
          if (destination.id === "replica") throw new Error("temporary transport failure");
        },
      },
    });
    const second = await coordinator.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations,
        send: async (record, destination) => {
          const payload = record.normalizedPayload as typeof input.normalizedPayload;
          sent.push(`${destination.id}:${payload.nested.value}`);
        },
      },
    });
    const store = createCaptureStore(root);
    expect(sent).toEqual(["primary:original", "replica:original", "replica:original"]);
    expect(first).toMatchObject({ status: "drained", delivered: 1, failed: 1, pending: 1 });
    expect(second).toMatchObject({ status: "drained", delivered: 1, pending: 0 });
    await expect(
      store.readOutcome(
        scope({
          integration: "claude-code",
          sessionId: "session-1",
          ...input,
        }),
        "primary",
      ),
    ).resolves.toMatchObject({
      status: "settled",
      receipt: { outcome: "delivered" },
    });
    await expect(
      store.readOutcome(
        scope({
          integration: "claude-code",
          sessionId: "session-1",
          ...input,
        }),
        "replica",
      ),
    ).resolves.toMatchObject({
      status: "settled",
      receipt: { outcome: "delivered" },
    });
  });

  it("does not send or age captures from another account", async () => {
    const root = temporaryRoot();
    const coordinator = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
      policy: { maxAgeMs: 1 },
    });
    const input = captureInput();
    await coordinator.capture(input);
    let sends = 0;
    const result = await coordinator.drain({
      writer: {
        accountFingerprint: "account-b",
        destinations: [{ id: "primary" }],
        send: async () => {
          sends += 1;
        },
      },
      now: Date.now() + 60_000,
    });
    expect(result).toMatchObject({ status: "drained", accountMismatch: 1 });
    expect(sends).toBe(0);
    await expect(
      createCaptureStore(root).readOutcome(
        {
          integration: "claude-code",
          sessionId: "session-1",
          turnId: input.turnId,
          eventId: input.eventId,
        },
        "primary",
      ),
    ).resolves.toEqual({ status: "pending" });
  });

  it("keeps the session scope and writer identity fixed during a drain", async () => {
    const options = {
      storageRoot: temporaryRoot(),
      integration: "claude-code",
      sessionId: "session-1",
    };
    const coordinator = createDeliveryCoordinator(options);
    options.integration = "cursor";
    options.sessionId = "session-2";
    await expect(coordinator.capture(captureInput("event-1", "run-1"))).resolves.toMatchObject({
      status: "published",
      record: { integration: "claude-code", sessionId: "session-1" },
    });
    await coordinator.capture(captureInput("event-2", "run-2"));
    options.sessionId = "session-3";
    class MutableWriter implements DeliveryWriter {
      account = "account-a";
      activeDestinations = [{ id: "primary" }];
      sent: string[] = [];

      get accountFingerprint() {
        return this.account;
      }
      get destinations() {
        return this.activeDestinations;
      }

      async send(
        _record: Parameters<DrainOptions["writer"]["send"]>[0],
        destination: Parameters<DrainOptions["writer"]["send"]>[1],
        accountFingerprint: Parameters<DrainOptions["writer"]["send"]>[2],
      ) {
        this.sent.push(`${accountFingerprint}/${destination.id}`);
        if (this.sent.length === 1) {
          this.account = "account-b";
          this.activeDestinations[0]!.id = "replica";
        }
      }
    }
    const writer = new MutableWriter();
    const result = await coordinator.drain({ writer });
    expect(result).toMatchObject({ status: "drained", delivered: 2, pending: 0 });
    expect(writer.sent).toEqual(["account-a/primary", "account-a/primary"]);
  });

  it("tracks post and patch acknowledgements as separate events", async () => {
    const root = temporaryRoot();
    const coordinator = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
    });
    await coordinator.capture({
      ...captureInput("run-post", "run-1"),
      eventKind: "run-post",
    });
    await coordinator.capture({
      ...captureInput("run-patch", "run-1"),
      eventKind: "run-patch",
      normalizedPayload: { id: "run-1", operation: "patch" },
    });
    const destinations = [{ id: "primary" }, { id: "replica" }];
    const first = await coordinator.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations,
        send: async (record, destination) => {
          if (record.eventId === "run-patch" && destination.id === "replica")
            throw new Error("temporary replica failure");
        },
      },
    });
    expect(first).toMatchObject({ status: "drained", delivered: 3, failed: 1, pending: 1 });
    const second = await coordinator.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations,
        send: async () => undefined,
      },
    });
    expect(second).toMatchObject({ status: "drained", delivered: 1, pending: 0 });
    const store = createCaptureStore(root);
    for (const eventId of ["run-post", "run-patch"]) {
      for (const destination of ["primary", "replica"]) {
        await expect(
          store.readOutcome(
            { integration: "claude-code", sessionId: "session-1", turnId: "turn-1", eventId },
            destination,
          ),
        ).resolves.toMatchObject({ status: "settled", receipt: { outcome: "delivered" } });
      }
    }
  });

  it("defers full-scope dependencies without consuming attempts", async () => {
    const root = temporaryRoot();
    const parent = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "parent-session",
      policy: { maxAttempts: 1 },
    });
    const child = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "child-session",
      policy: { maxAttempts: 1 },
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
      send: async (record: { eventId: string }) => {
        order.push(record.eventId);
      },
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
        send: async (record) => {
          sent.push(record.eventId);
        },
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
      const size = 24;
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
          send: async (record) => {
            sent.push(record.eventId);
          },
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

  it("cascades a dropped prerequisite into an immutable dropped receipt", async () => {
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
        send: async () => {
          sends += 1;
        },
      },
    });
    expect(result).toMatchObject({ status: "drained", dropped: 1, pending: 0 });
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
    ).resolves.toMatchObject({
      status: "settled",
      receipt: { outcome: "dropped", reason: "dependency-dropped" },
    });
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
        send: async () => {
          sends += 1;
        },
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

  it("lets only the process holding the session lock send pending events", async () => {
    const coordinator = createDeliveryCoordinator({
      storageRoot: temporaryRoot(),
      integration: "claude-code",
      sessionId: "session-1",
    });
    await coordinator.capture(captureInput());
    let beginSend!: () => void;
    let finishSend!: () => void;
    const sending = new Promise<void>((resolve) => {
      beginSend = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    let secondSends = 0;
    const firstDrain = coordinator.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations: [{ id: "primary" }],
        send: async () => {
          beginSend();
          await blocked;
        },
      },
    });
    await sending;
    const secondDrain = await coordinator.drain({
      writer: {
        accountFingerprint: "account-a",
        destinations: [{ id: "primary" }],
        send: async () => {
          secondSends += 1;
        },
      },
    });
    await expect(coordinator.capture(captureInput("event-2", "run-2"))).resolves.toMatchObject({
      status: "published",
    });
    finishSend();
    await expect(firstDrain).resolves.toMatchObject({ delivered: 1, pending: 1 });
    expect(secondDrain).toEqual({ status: "busy" });
    expect(secondSends).toBe(0);
    await expect(
      coordinator.drain({
        writer: {
          accountFingerprint: "account-a",
          destinations: [{ id: "primary" }],
          send: async () => {
            secondSends += 1;
          },
        },
      }),
    ).resolves.toMatchObject({ delivered: 1, pending: 0 });
    expect(secondSends).toBe(1);
  });

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
