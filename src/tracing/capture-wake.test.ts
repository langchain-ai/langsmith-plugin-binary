import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCaptureStore } from "../storage/capture/index.js";
import { CaptureWakeError, readSavedCaptureWake } from "./index.js";
import type { SavedCaptureWakeOptions } from "./capture-wake-models.js";

it("accepts only matching durable captures after a worker wake fails", async () => {
  const store = createCaptureStore(mkdtempSync(join(tmpdir(), "saved-capture-wake-")));
  const input = {
    integration: "cursor",
    sessionId: "session",
    turnId: "turn",
    eventId: "event",
    runId: "run",
    destinationFingerprint: "account",
    eventKind: "run-post",
    normalizedPayload: {
      operation: "post",
      integration: "cursor",
      privacyMode: "full",
      run: { inputs: { prompt: "synthetic" }, outputs: { result: "ok" } },
    },
    turnEvidence: {},
    metadataProvenance: {},
  };
  const result = await store.capture(input);
  if (result.status !== "published") throw new Error("Fixture capture failed");
  const error = new CaptureWakeError(result, new Error("Worker unavailable"));
  const options: SavedCaptureWakeOptions = { ...input, store };
  await expect(readSavedCaptureWake(error, options)).resolves.toEqual(result);
  await expect(
    readSavedCaptureWake(
      new CaptureWakeError(
        { ...result, record: { ...result.record, capturedAtMs: result.record.capturedAtMs + 1 } },
        new Error("Worker unavailable"),
      ),
      options,
    ),
  ).resolves.toBeUndefined();
  const markerStore = createCaptureStore(mkdtempSync(join(tmpdir(), "untrusted-capture-marker-")));
  const markerPublished = await markerStore.capture(input);
  if (markerPublished.status !== "published") throw new Error("Fixture capture failed");
  const markerCompaction = await markerStore.compact(input, markerPublished.record);
  if (markerCompaction.status !== "compacted") throw new Error("Fixture compaction failed");
  await expect(
    readSavedCaptureWake(
      new CaptureWakeError(
        {
          ...result,
          record: { ...markerCompaction.record, capturedAtMs: result.record.capturedAtMs },
        },
        new Error("Worker unavailable"),
      ),
      options,
    ),
  ).resolves.toBeUndefined();
  await expect(readSavedCaptureWake(new Error("Not saved"), options)).resolves.toBeUndefined();
  for (const key of [
    "integration",
    "sessionId",
    "turnId",
    "eventId",
    "runId",
    "destinationFingerprint",
  ] as const) {
    await expect(
      readSavedCaptureWake(error, { ...options, [key]: "different" }),
    ).resolves.toBeUndefined();
  }
  await expect(
    readSavedCaptureWake(error, {
      ...options,
      store: { read: async () => undefined },
    }),
  ).resolves.toBeUndefined();
  await expect(
    readSavedCaptureWake(error, {
      ...options,
      store: { read: async () => ({ ...result.record, normalizedPayload: { input: "changed" } }) },
    }),
  ).resolves.toBeUndefined();
  await expect(
    readSavedCaptureWake(error, {
      ...options,
      store: {
        read: async () => {
          throw new Error("Unreadable capture");
        },
      },
    }),
  ).rejects.toThrow("Unreadable capture");
  const verified = structuredClone(result);
  await expect(
    readSavedCaptureWake(error, {
      ...options,
      store: {
        read: async (scope) => {
          result.record.normalizedPayload = { input: "changed while reading" };
          result.record = { ...result.record, runId: "replacement" };
          return store.read(scope);
        },
      },
    }),
  ).resolves.toEqual(verified);
});

it("accepts only exact or durably compacted capture records", async () => {
  const store = createCaptureStore(mkdtempSync(join(tmpdir(), "saved-compacted-wake-")));
  const input = {
    integration: "cursor",
    sessionId: "session",
    turnId: "turn",
    eventId: "event",
    runId: "run",
    destinationFingerprint: "account",
    eventKind: "run-post",
    normalizedPayload: {
      operation: "post",
      integration: "cursor",
      privacyMode: "full",
      run: { id: "run", name: "test", run_type: "chain", inputs: { prompt: "secret" } },
    },
    turnEvidence: {},
    metadataProvenance: {},
  };
  const published = await store.capture(input);
  if (published.status !== "published") throw new Error("Fixture capture failed");
  const compaction = await store.compact(input, published.record);
  if (compaction.status !== "compacted") throw new Error("Fixture compaction failed");
  const error = new CaptureWakeError(published, new Error("Worker unavailable"));
  await expect(readSavedCaptureWake(error, { ...input, store })).resolves.toMatchObject({
    record: compaction.record,
  });
  await expect(
    readSavedCaptureWake(
      new CaptureWakeError(
        { ...published, record: compaction.record },
        new Error("Worker unavailable"),
      ),
      { ...input, store },
    ),
  ).resolves.toMatchObject({ record: compaction.record });
  await expect(
    readSavedCaptureWake(
      new CaptureWakeError(
        {
          ...published,
          record: {
            ...compaction.record,
            normalizedPayload: { operation: "post", run: { id: "run", name: "changed" } },
          },
        },
        new Error("Worker unavailable"),
      ),
      { ...input, store },
    ),
  ).resolves.toBeUndefined();
  await expect(
    readSavedCaptureWake(
      new CaptureWakeError(
        {
          ...published,
          record: { ...published.record, capturedAtMs: published.record.capturedAtMs + 1 },
        },
        new Error("Worker unavailable"),
      ),
      { ...input, store },
    ),
  ).resolves.toBeUndefined();
});

it("preserves capture timestamps when reconstruction snapshots are cleaned up", async () => {
  const store = createCaptureStore(mkdtempSync(join(tmpdir(), "saved-cleanup-wake-")));
  const input = {
    integration: "cursor",
    sessionId: "session",
    turnId: "turn",
    eventId: "event",
    runId: "reconstruction:run",
    destinationFingerprint: "account",
    eventKind: "reconstruction-job-v1",
    normalizedPayload: { sourceSnapshots: [{ sourceRef: "source" }] },
    turnEvidence: {},
    metadataProvenance: {},
  };
  const published = await store.capture(input);
  if (published.status !== "published") throw new Error("Fixture capture failed");
  await store.recordOutcome({ ...input, destination: "account", outcome: "delivered" });
  const cleanup = await store.compactReconstructionJob(input, published.record, "account");
  if (cleanup.status !== "compacted") throw new Error("Fixture cleanup failed");
  const error = new CaptureWakeError(published, new Error("Worker unavailable"));

  await expect(readSavedCaptureWake(error, { ...input, store })).resolves.toMatchObject({
    record: cleanup.record,
  });
  await expect(
    readSavedCaptureWake(
      new CaptureWakeError(
        {
          ...published,
          record: { ...published.record, capturedAtMs: published.record.capturedAtMs + 1 },
        },
        new Error("Worker unavailable"),
      ),
      { ...input, store },
    ),
  ).resolves.toBeUndefined();
});
