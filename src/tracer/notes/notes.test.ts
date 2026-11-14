import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NOTES_ROTATE_BYTES, ROTATED_NOTES_SETTLE_MS } from "./notes-constants.js";
import { NotesFollower } from "./notes.js";

const PADDING = "x".repeat(1023);

afterEach(() => {
  vi.restoreAllMocks();
});

function follow(notes: string) {
  const received: string[] = [];
  const follower = new NotesFollower(notes, (line) => {
    if (line !== PADDING) received.push(line);
  });
  return { follower, received };
}

function notesPastRotation(firstLine = ""): string {
  const notes = join(mkdtempSync(join(tmpdir(), "tracer notes ")), "notes.jsonl");
  writeFileSync(notes, firstLine + `${PADDING}\n`.repeat(NOTES_ROTATE_BYTES / 1024));
  return notes;
}

it("holds a half-written note until its line is complete", () => {
  const notes = join(mkdtempSync(join(tmpdir(), "tracer notes ")), "notes.jsonl");
  const { follower, received } = follow(notes);
  writeFileSync(notes, "one\ntw");
  follower.take();
  expect(received).toEqual(["one"]);
  expect(follower.unread()).toBe(true);
  appendFileSync(notes, "o\n");
  follower.take();
  expect(received).toEqual(["one", "two"]);
  expect(follower.unread()).toBe(false);
});

it("reads a note a slow hook writes into the rotated file once the rotation settles", () => {
  const notes = notesPastRotation();
  const slowHook = openSync(notes, "a");
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const { follower, received } = follow(notes);
  follower.take();
  follower.take();
  writeSync(slowHook, "late\n");
  closeSync(slowHook);
  appendFileSync(notes, "new\n");
  follower.take();
  now.mockReturnValue(1_000 + ROTATED_NOTES_SETTLE_MS);
  follower.take();
  expect(received).toEqual(["new", "late"]);
  expect(readdirSync(dirname(notes))).toEqual(["notes.jsonl"]);
});

it("resumes from a saved bookmark and reads the rotated file a killed follower left", () => {
  const notes = notesPastRotation("old\n");
  const slowHook = openSync(notes, "a");
  const killed = follow(notes);
  killed.follower.resume({ base: 0, offset: "old\n".length });
  killed.follower.take();
  appendFileSync(notes, "new\n");
  writeSync(slowHook, "late\n");
  closeSync(slowHook);
  const restarted = follow(notes);
  restarted.follower.resume({ base: 0, offset: "old\n".length });
  restarted.follower.take();
  expect(restarted.received).toEqual(["late", "new"]);
  expect(readdirSync(dirname(notes))).toEqual(["notes.jsonl"]);
});
