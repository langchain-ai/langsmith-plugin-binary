import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { FILE_MISSING_CODE } from "../../utils/constants.js";
import { errorCode } from "../../utils/errors.js";
import type { NotesBookmark } from "../models.js";
import { removeFile } from "../../utils/files/remove.js";
import { NEWLINE } from "../reader/reader-constants.js";
import {
  NOTES_ROTATE_BYTES,
  ROTATED_NOTES_NAME,
  ROTATED_NOTES_SETTLE_MS,
  ROTATED_NOTES_SUFFIX,
} from "./notes-constants.js";
import type { NotesRead, RotatedLeftover, RotatedNotes } from "./notes-models.js";

export class NotesFollower {
  private base = 0;
  private offset = 0;
  private readonly rotated: RotatedNotes[] = [];

  constructor(
    private readonly notes: string,
    private readonly receive: (line: string) => void,
  ) {}

  private readFrom(path: string, offset: number): NotesRead {
    let file: number;
    try {
      file = openSync(path, "r");
    } catch (error) {
      if (errorCode(error) === FILE_MISSING_CODE) return { offset, size: 0 };
      throw error;
    }
    try {
      const size = fstatSync(file).size;
      const buffer = Buffer.alloc(Math.max(0, size - offset));
      readSync(file, buffer, 0, buffer.length, offset);
      const complete = buffer.lastIndexOf(NEWLINE) + 1;
      const text = buffer.subarray(0, complete).toString("utf8");
      for (const line of text.split("\n").filter(Boolean)) this.receive(line);
      return { offset: offset + complete, size };
    } finally {
      closeSync(file);
    }
  }

  private leftovers(): RotatedLeftover[] {
    const folder = dirname(this.notes);
    const prefix = `${basename(this.notes)}${ROTATED_NOTES_SUFFIX}`;
    return readdirSync(folder)
      .filter((name) => name.startsWith(prefix))
      .flatMap((name) => {
        const match = ROTATED_NOTES_NAME.exec(name);
        if (match === null) return [];
        return [{ path: join(folder, name), base: Number(match[1]), nextBase: Number(match[2]) }];
      })
      .toSorted((left, right) => left.base - right.base);
  }

  resume(bookmark: NotesBookmark): void {
    const position = bookmark.base + bookmark.offset;
    this.base = bookmark.base;
    for (const leftover of this.leftovers()) {
      this.readFrom(leftover.path, Math.max(0, position - leftover.base));
      removeFile(leftover.path);
      this.base = Math.max(this.base, leftover.nextBase);
    }
    this.offset = Math.max(0, position - this.base);
  }

  take(): void {
    this.settle();
    const read = this.readFrom(this.notes, this.offset);
    if (read.size < this.offset) {
      this.base += this.offset;
      this.offset = 0;
      return;
    }
    this.offset = read.offset;
    if (this.offset >= NOTES_ROTATE_BYTES && read.size === this.offset) this.rotate();
  }

  private rotate(): void {
    const nextBase = this.base + this.offset;
    const path = `${this.notes}${ROTATED_NOTES_SUFFIX}${this.base}-${nextBase}`;
    renameSync(this.notes, path);
    this.rotated.push({ path, offset: this.offset, rotatedAt: Date.now() });
    this.base = nextBase;
    this.offset = 0;
  }

  private settle(): void {
    for (
      let next = this.rotated[0];
      next !== undefined && Date.now() - next.rotatedAt >= ROTATED_NOTES_SETTLE_MS;
      next = this.rotated[0]
    ) {
      this.readFrom(next.path, next.offset);
      removeFile(next.path);
      this.rotated.shift();
    }
  }

  bookmark(): NotesBookmark {
    return { base: this.base, offset: this.offset };
  }

  rotating(): boolean {
    return this.rotated.length > 0;
  }

  unread(): boolean {
    const size = statSync(this.notes, { throwIfNoEntry: false })?.size ?? 0;
    return this.rotating() || size > this.offset;
  }
}
