import { statSync } from "node:fs";
import { describe } from "../../utils/errors.js";
import type {
  Bookmark,
  PositionedHookNote,
  ReadLine,
  ReadNewLines,
  SessionSnapshot,
} from "../models.js";
import { SESSION_END_EVENT } from "./worker-constants.js";
import type { Log, WorkerSession } from "./worker-models.js";

const fileSize = (path: string) => statSync(path, { throwIfNoEntry: false })?.size ?? 0;

function sessionTranscripts(session: WorkerSession): string[] {
  return [...new Set([...Object.keys(session.bookmarks), ...session.builder.transcripts()])];
}

export function positionNote(session: WorkerSession, note: PositionedHookNote): PositionedHookNote {
  const transcriptSizes = { ...note.transcriptSizes };
  for (const path of sessionTranscripts(session)) transcriptSizes[path] ??= fileSize(path);
  return { ...note, transcriptSizes };
}

function noteReached(session: WorkerSession, note: PositionedHookNote): boolean {
  return Object.entries(note.transcriptSizes).every(
    ([path, size]) => (session.bookmarks[path]?.offset ?? 0) >= size,
  );
}

function deliverReadyNotes(session: WorkerSession, log: Log): boolean {
  let delivered = false;
  for (let note = session.pendingNotes[0]; note !== undefined; note = session.pendingNotes[0]) {
    if (!noteReached(session, note)) break;
    session.pendingNotes.shift();
    delivered = true;
    if (note.event === SESSION_END_EVENT) session.ended = true;
    try {
      session.builder.receiveNote(note);
    } catch (error) {
      log(`could not apply ${note.event} for ${session.sessionId}: ${describe(error)}`);
    }
  }
  return delivered;
}

function readLimit(session: WorkerSession, path: string): number {
  return session.pendingNotes[0]?.transcriptSizes[path] ?? Infinity;
}

function reachNoteAt(session: WorkerSession, path: string, offset: number): void {
  const sizes = session.pendingNotes[0]?.transcriptSizes;
  const size = sizes?.[path];
  if (sizes !== undefined && size !== undefined && size > offset) sizes[path] = offset;
}

function deliverLine(session: WorkerSession, bookmark: Bookmark, read: ReadLine, log: Log): void {
  try {
    session.builder.readLine(bookmark.path, read.line);
  } catch (error) {
    log(`could not trace a line in ${bookmark.path}: ${describe(error)}`);
  }
  bookmark.offset = read.end;
  const id = session.builder.lineId(read.line);
  if (id !== undefined) bookmark.lastLineId = id;
}

function moveBookmark(bookmark: Bookmark, to: Bookmark): void {
  bookmark.offset = to.offset;
  if (to.lastLineId === undefined) delete bookmark.lastLineId;
  else bookmark.lastLineId = to.lastLineId;
}

function readTranscript(
  session: WorkerSession,
  path: string,
  readNewLines: ReadNewLines,
  log: Log,
): boolean {
  const bookmark = (session.bookmarks[path] ??= { path, offset: 0 });
  const readFrom = { ...bookmark };
  const lines = readNewLines(bookmark, session.builder.lineId, log);
  const readTo = { ...bookmark };
  moveBookmark(bookmark, readFrom);
  let advanced = false;
  for (const read of lines) {
    if (read.end > readLimit(session, path)) {
      reachNoteAt(session, path, bookmark.offset);
      deliverReadyNotes(session, log);
      if (read.end > readLimit(session, path)) return advanced;
    }
    deliverLine(session, bookmark, read, log);
    advanced = true;
  }
  if (readTo.offset > bookmark.offset) moveBookmark(bookmark, readTo);
  return advanced;
}

function settleUnreachableNote(session: WorkerSession): boolean {
  const sizes = session.pendingNotes[0]?.transcriptSizes ?? {};
  let settled = false;
  for (const [path, size] of Object.entries(sizes)) {
    const offset = session.bookmarks[path]?.offset ?? 0;
    if (offset >= size || fileSize(path) >= size) continue;
    sizes[path] = offset;
    settled = true;
  }
  return settled;
}

export function readPass(
  session: WorkerSession,
  readNewLines: ReadNewLines,
  log: Log,
  paused: () => boolean,
): boolean {
  let progressed = false;
  for (;;) {
    if (paused()) return progressed;
    let advanced = deliverReadyNotes(session, log);
    for (const path of sessionTranscripts(session))
      advanced = readTranscript(session, path, readNewLines, log) || advanced;
    if (!advanced) advanced = settleUnreachableNote(session);
    if (!advanced) return progressed;
    progressed = true;
  }
}

export function snapshotOf({ builder, ...saved }: WorkerSession): SessionSnapshot {
  return { ...saved, builderState: builder.state() };
}
