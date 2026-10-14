import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
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

export function pathsUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) =>
    join(entry.parentPath, entry.name),
  );
}

export function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}
