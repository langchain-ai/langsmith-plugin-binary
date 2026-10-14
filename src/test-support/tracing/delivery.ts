import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { CaptureScope, StoredCapture } from "../../storage/capture/models.js";
import type {
  DeliveryCaptureInput,
  DeliveryDestination,
  DeliveryWriter,
} from "../../tracing/delivery/models.js";

export function sendOneAtATime(
  send: (
    record: StoredCapture,
    destination: DeliveryDestination,
    accountFingerprint: string,
  ) => Promise<void>,
): Pick<DeliveryWriter, "batchLimits" | "sendBatch"> {
  return {
    batchLimits: { maxRecords: 1, maxBytes: Infinity },
    sendBatch: async (records, destination, accountFingerprint) => {
      for (const record of records) await send(record, destination, accountFingerprint);
    },
  };
}

export const execFileAsync = promisify(execFile);

export function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "plugins base delivery "));
}

export function captureInput(eventId = "event-1", runId = "run-1"): DeliveryCaptureInput {
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

export function moduleUrl(relativePath: string): string {
  return pathToFileURL(join(process.cwd(), relativePath)).href;
}

export function childEnvironment(home: string): NodeJS.ProcessEnv {
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

export function scope(record: CaptureScope): CaptureScope {
  return {
    integration: record.integration,
    sessionId: record.sessionId,
    turnId: record.turnId,
    eventId: record.eventId,
  };
}

export function exitCode(error: unknown): number | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined;
}

function pathsUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) =>
    join(entry.parentPath, entry.name),
  );
}

export function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

const MARKER_FILE = /\.outcome$/u;

export function recordFilesUnder(root: string): string[] {
  return filesUnder(root).filter((path) => !MARKER_FILE.test(path));
}

function withoutMarkers(root: string, paths: readonly string[]): string[] {
  const markers = filesUnder(root).filter((path) => MARKER_FILE.test(path));
  return paths.filter(
    (path) => !markers.some((marker) => marker === path || marker.startsWith(`${path}${sep}`)),
  );
}

export function expectNoFilesLeft(root: string): void {
  expect(withoutMarkers(root, filesUnder(root))).toEqual([]);
}

export function expectNoPathsLeft(root: string): void {
  expect(withoutMarkers(root, pathsUnder(root))).toEqual([]);
}
