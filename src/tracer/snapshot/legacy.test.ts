import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { importLegacyState } from "./legacy.js";
import type { TracingMode } from "../models.js";
import type { LegacySession } from "./snapshot-models.js";
import { loadSnapshot, writeSnapshot } from "./snapshot.js";

vi.mock("node:fs", { spy: true });

const HOUR_MS = 60 * 60 * 1000;
const writer = { destinations: [], redact: true };

function oldInstall(): string {
  const stateFolder = fs.mkdtempSync(join(tmpdir(), "tracer legacy "));
  fs.mkdirSync(join(stateFolder, "langsmith_engine", "sessions"), { recursive: true });
  fs.writeFileSync(join(stateFolder, "langsmith_engine", "sessions", "run.json"), "{}");
  fs.writeFileSync(join(stateFolder, "langsmith_state.json"), "{}");
  return stateFolder;
}

const legacy = (
  sessionId: string,
  hoursAgo: number,
  tracingMode: TracingMode = "full",
): LegacySession => ({
  sessionId,
  transcriptPath: `/transcripts/${sessionId}.jsonl`,
  updatedAt: Date.now() - hoursAgo * HOUR_MS,
  tracingMode,
});

const imported = (sessionId: string, tracingMode: TracingMode) => {
  const path = `/transcripts/${sessionId}.jsonl`;
  return {
    sessionId,
    integration: "claude-code",
    writer,
    bookmarks: { [path]: { path, offset: 0 } },
    pendingNotes: [],
    tracingMode,
    ended: false,
  };
};

const runImport = (stateFolder: string, sessions: LegacySession[]) =>
  importLegacyState({
    stateFolder,
    integration: "claude-code",
    writer,
    readLegacySessions: () => sessions,
  });

const snapshotPath = (stateFolder: string) =>
  join(stateFolder, "langsmith_plugins_base", "snapshot.json");

it("imports the last day's sessions with their tracing mode and then purges the old storage", () => {
  const stateFolder = oldInstall();
  const count = runImport(stateFolder, [
    legacy("recent", 2),
    legacy("muted", 1, "off"),
    legacy("stale", 30),
  ]);
  expect(count).toBe(2);
  expect(loadSnapshot(snapshotPath(stateFolder)).snapshot.sessions).toEqual({
    recent: imported("recent", "full"),
    muted: imported("muted", "off"),
  });
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
});

it("leaves the old folder and state file untouched when killed before the snapshot rename", () => {
  const stateFolder = oldInstall();
  vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
    throw new Error("killed");
  });
  expect(() => runImport(stateFolder, [legacy("recent", 1)])).toThrow("killed");
  expect(
    fs.readFileSync(join(stateFolder, "langsmith_engine", "sessions", "run.json"), "utf8"),
  ).toBe("{}");
  expect(fs.readFileSync(join(stateFolder, "langsmith_state.json"), "utf8")).toBe("{}");
});

it("keeps the worker's progress when rerun after a kill between the rename and the purge", () => {
  const stateFolder = oldInstall();
  runImport(stateFolder, [legacy("recent", 1)]);
  const advanced = { ...imported("recent", "full"), builderState: 1 };
  advanced.bookmarks["/transcripts/recent.jsonl"]!.offset = 500;
  writeSnapshot(snapshotPath(stateFolder), { version: 1, sessions: { recent: advanced } });
  fs.mkdirSync(join(stateFolder, "langsmith_engine"));
  fs.writeFileSync(join(stateFolder, "langsmith_state.json"), "{}");
  expect(runImport(stateFolder, [legacy("recent", 1)])).toBe(0);
  expect(loadSnapshot(snapshotPath(stateFolder)).snapshot.sessions).toEqual({ recent: advanced });
  expect(fs.readdirSync(stateFolder)).toEqual(["langsmith_plugins_base"]);
});

it("writes nothing when rerun after a completed import", () => {
  const stateFolder = oldInstall();
  runImport(stateFolder, [legacy("recent", 1)]);
  const rename = vi.spyOn(fs, "renameSync");
  rename.mockClear();
  expect(runImport(stateFolder, [legacy("other", 1)])).toBe(0);
  expect(rename).not.toHaveBeenCalled();
});

it("refuses a relative state folder so the purge cannot land in the working directory", () => {
  expect(() => runImport("", [])).toThrow(
    'refusing to import legacy state from relative folder ""',
  );
});
