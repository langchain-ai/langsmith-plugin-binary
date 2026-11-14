import { readSync } from "node:fs";
import type { Bookmark } from "../models.js";
import { parseLine, scanLines } from "./lines.js";
import { BOOKMARK_CHECK_BYTES } from "./reader-constants.js";
import type { LineIdReader } from "./reader-models.js";

export function recoverBookmark(
  file: number,
  size: number,
  bookmark: Bookmark,
  lineId: LineIdReader,
  notices: string[],
): void {
  if (bookmark.offset === 0) return;
  const id = bookmark.lastLineId;
  if (id === undefined) {
    if (bookmark.offset <= size) return;
    bookmark.offset = 0;
    notices.push(
      `${bookmark.path} shrank and has no line ID to resume from, reading from the start`,
    );
    return;
  }
  if (bookmark.offset <= size && lastIdEndingAt(file, bookmark.offset, lineId) === id) return;
  const end = findLineEnd(file, size, id, lineId);
  if (end === undefined) {
    bookmark.offset = 0;
    notices.push(`line ${id} is gone from ${bookmark.path}, reading from the start`);
    return;
  }
  bookmark.offset = end;
  notices.push(`${bookmark.path} changed, resuming after line ${id} at byte ${end}`);
}

function lastIdEndingAt(file: number, offset: number, lineId: LineIdReader): string | undefined {
  const start = Math.max(0, offset - BOOKMARK_CHECK_BYTES);
  const window = Buffer.alloc(offset - start);
  readSync(file, window, 0, window.length, start);
  const text = window.toString("utf8");
  if (!text.endsWith("\n")) return undefined;
  const pieces = text.slice(0, -1).split("\n");
  for (const piece of pieces.toReversed()) {
    const line = parseLine(piece);
    const id = line === undefined ? undefined : lineId(line);
    if (id !== undefined) return id;
  }
  return undefined;
}

function findLineEnd(
  file: number,
  size: number,
  id: string,
  lineId: LineIdReader,
): number | undefined {
  let found: number | undefined;
  scanLines(file, 0, size, (text, end) => {
    if (!text.includes(id)) return false;
    const line = parseLine(text);
    if (line === undefined || lineId(line) !== id) return false;
    found = end;
    return true;
  });
  return found;
}
