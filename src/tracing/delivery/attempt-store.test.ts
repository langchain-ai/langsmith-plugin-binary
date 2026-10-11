import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDeliveryAttemptStore } from "./attempt-store.js";
import { DELIVERY_ATTEMPT_VERSION, DELIVERY_DIRECTORY } from "./constants.js";
import type { CaptureScope } from "../../storage/capture/models.js";
import { identifierHash } from "../../storage/capture/paths.js";

const attemptTime = "2026-10-10T12:00:00.000Z";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "plugins-base-delivery-attempt-"));
}

function scope(): CaptureScope {
  return {
    integration: "claude-code",
    sessionId: "session-1",
    turnId: "turn-1",
    eventId: "event-1",
  };
}

describe("delivery attempt store", () => {
  it("counts sequential destination attempts and rejects duplicate records", async () => {
    const store = createDeliveryAttemptStore(temporaryRoot());
    const recordScope = scope();

    await store.record(recordScope, "primary", 1, attemptTime);
    await expect(store.count(recordScope, "primary")).resolves.toBe(1);
    await expect(store.record(recordScope, "primary", 1, attemptTime)).rejects.toThrow(
      "Delivery attempt already exists",
    );
    await expect(store.count(recordScope, "primary")).resolves.toBe(1);
  });

  it("rejects gaps in a destination's persisted attempt sequence", async () => {
    const store = createDeliveryAttemptStore(temporaryRoot());
    const recordScope = scope();

    await store.record(recordScope, "primary", 2, attemptTime);

    await expect(store.count(recordScope, "primary")).rejects.toThrow(
      "Delivery attempt sequence has a gap",
    );
  });

  it("rejects records whose saved scope differs from their private path", async () => {
    const root = temporaryRoot();
    const recordScope = scope();
    const destination = "primary";
    const directory = join(
      root,
      DELIVERY_DIRECTORY,
      "integrations",
      recordScope.integration,
      "sessions",
      identifierHash(recordScope.sessionId),
      "turns",
      identifierHash(recordScope.turnId),
      "events",
      identifierHash(recordScope.eventId),
      "destinations",
      identifierHash(destination),
      "attempts",
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, "1.json"),
      JSON.stringify({
        version: DELIVERY_ATTEMPT_VERSION,
        ...recordScope,
        sessionId: "other-session",
        destination,
        attempt: 1,
        startedAt: attemptTime,
      }),
      { mode: 0o600 },
    );

    await expect(createDeliveryAttemptStore(root).count(recordScope, destination)).rejects.toThrow(
      "Delivery attempt namespace does not match",
    );
  });
});
