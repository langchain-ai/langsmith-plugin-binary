import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeliveryCoordinator } from "./coordinator.js";
import type { DeliveryWriter, DrainOptions } from "./models.js";
import { createCaptureStore } from "../../storage/capture/index.js";
import { receiptPath } from "../../storage/capture/paths.js";
import {
  captureInput,
  childEnvironment,
  errorCode,
  execFileAsync,
  moduleUrl,
  scope,
  temporaryRoot,
} from "../../test-support/tracing/delivery.js";

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

  it("fails loudly when a compacted capture loses a destination receipt", async () => {
    const root = temporaryRoot();
    const coordinator = createDeliveryCoordinator({
      storageRoot: root,
      integration: "claude-code",
      sessionId: "session-1",
    });
    const input = {
      ...captureInput("compacted-run", "run-compact"),
      eventKind: "run-post",
      normalizedPayload: {
        operation: "post",
        integration: "claude-code",
        privacyMode: "full",
        run: { id: "run-compact", name: "test", run_type: "chain", inputs: { prompt: "large" } },
      },
    };
    const captured = await coordinator.capture(input);
    if (captured.status !== "published") throw new Error("Run capture was not published");
    const store = createCaptureStore(root);
    const recordScope = scope({ integration: "claude-code", sessionId: "session-1", ...input });
    const destinations = [{ id: "primary" }, { id: "replica" }];
    for (const destination of destinations) {
      await expect(
        store.recordOutcome({ ...recordScope, destination: destination.id, outcome: "delivered" }),
      ).resolves.toMatchObject({ status: "recorded" });
    }
    await expect(store.compact(recordScope, captured.record)).resolves.toMatchObject({
      status: "compacted",
    });
    const send = vi.fn();

    await expect(
      coordinator.drain({
        writer: { accountFingerprint: "account-a", destinations, send },
      }),
    ).resolves.toMatchObject({ status: "drained", delivered: 0, pending: 0 });
    expect(send).not.toHaveBeenCalled();

    unlinkSync(receiptPath(root, recordScope, "replica"));
    await expect(
      coordinator.drain({
        writer: { accountFingerprint: "account-a", destinations, send },
      }),
    ).rejects.toThrow(
      "Compacted capture compacted-run has no delivered receipt for destination replica",
    );
    expect(send).not.toHaveBeenCalled();
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
});
