import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../models.js";
import { loadSnapshot, writeSnapshot } from "./snapshot.js";

vi.mock("node:fs", { spy: true });

const snapshotPath = () =>
  join(fs.mkdtempSync(join(tmpdir(), "tracer snapshot ")), "snapshot.json");

const session = (sessionId: string, offset: number): SessionSnapshot => ({
  sessionId,
  integration: "claude-code",
  writer: { destinations: [], redact: false },
  bookmarks: { "/t.jsonl": { path: "/t.jsonl", offset } },
  pendingNotes: [],
  builderState: { offset },
  ended: false,
});

it("keeps the old snapshot intact when the worker dies between the temp write and the rename", () => {
  const path = snapshotPath();
  writeSnapshot(path, { version: 1, sessions: { one: session("one", 10) } });
  vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
    throw new Error("killed");
  });
  expect(() => writeSnapshot(path, { version: 1, sessions: { one: session("one", 99) } })).toThrow(
    "killed",
  );
  expect(loadSnapshot(path)).toEqual({
    snapshot: { version: 1, sessions: { one: session("one", 10) } },
  });
});

it("loads a corrupt or unknown version file as empty and reports it", () => {
  const path = snapshotPath();
  fs.writeFileSync(path, '{"version":1,"sess');
  expect(loadSnapshot(path).snapshot).toEqual({ version: 1, sessions: {} });
  expect(loadSnapshot(path).problem).toMatch(/^ignored unreadable /);
  fs.writeFileSync(path, '{"version":2,"sessions":{"one":{}}}');
  expect(loadSnapshot(path)).toEqual({
    snapshot: { version: 1, sessions: {} },
    problem: `ignored ${path} since its version is unknown`,
  });
});
