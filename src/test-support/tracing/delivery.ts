import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { CaptureScope } from "../../storage/capture/models.js";
import type { DeliveryCaptureInput } from "../../tracing/delivery/models.js";

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

export function errorCode(error: unknown): number | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined;
}
