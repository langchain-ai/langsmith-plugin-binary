import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readNewLines } from "../reader/reader.js";
import { readPass } from "./session.js";
import type { WorkerSession } from "./worker-models.js";

const line = (uuid: string) => `${JSON.stringify({ uuid })}\n`;
const writer = { destinations: [], redact: false };

it("rereads lines a pending note held back after the real reader moved past them", () => {
  const folder = mkdtempSync(join(tmpdir(), "tw-"));
  const [main, subagent] = [join(folder, "main.jsonl"), join(folder, "subagent.jsonl")];
  writeFileSync(main, `${line("L1")}${line("L2")}${line("L3")}not a transcript line\n`);
  writeFileSync(subagent, line("S1"));
  const mainBeforeStop = line("L1").length;
  const applied: string[] = [];
  const session: WorkerSession = {
    sessionId: "s",
    integration: "claude",
    writer,
    ended: false,
    bookmarks: {
      [main]: { path: main, offset: mainBeforeStop, lastLineId: "L1" },
      [subagent]: { path: subagent, offset: 0 },
    },
    pendingNotes: [
      {
        integration: "claude",
        event: "Stop",
        sessionId: "s",
        writer,
        transcriptSizes: { [main]: mainBeforeStop, [subagent]: statSync(subagent).size },
      },
    ],
    builder: {
      lineId: (read) => String(read.uuid),
      readLine: (_path, read) => applied.push(String(read.uuid)),
      receiveNote: (note) => applied.push(note.event),
      transcripts: () => [],
      state: () => ({}),
    },
  };
  readPass(
    session,
    (bookmark, lineId) => readNewLines(bookmark, lineId).lines,
    () => undefined,
    () => false,
  );
  expect(applied).toEqual(["S1", "Stop", "L2", "L3"]);
  expect(session.bookmarks[main]).toEqual({
    path: main,
    offset: statSync(main).size,
    lastLineId: "L3",
  });
});
