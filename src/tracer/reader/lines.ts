import { readSync } from "node:fs";
import { NEWLINE, READ_CHUNK_BYTES } from "./reader-constants.js";
import type { LineVisitor } from "./reader-models.js";

export function scanLines(file: number, from: number, to: number, visit: LineVisitor): number {
  let carried = Buffer.alloc(0);
  let carriedStart = from;
  let position = from;
  while (position < to) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, to - position));
    const count = readSync(file, chunk, 0, chunk.length, position);
    if (count === 0) break;
    position += count;
    const data = Buffer.concat([carried, chunk.subarray(0, count)]);
    let lineStart = 0;
    let newline = data.indexOf(NEWLINE);
    while (newline !== -1) {
      const end = carriedStart + newline + 1;
      if (visit(data.subarray(lineStart, newline), end)) return end;
      lineStart = newline + 1;
      newline = data.indexOf(NEWLINE, lineStart);
    }
    carried = Buffer.from(data.subarray(lineStart));
    carriedStart += lineStart;
  }
  return carriedStart;
}

export function parseLine(text: Buffer | string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text.toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
