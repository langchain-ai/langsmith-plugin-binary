import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VersionCheckFailure } from "../models.js";
import { failureKind, reportedVersion } from "./process.js";

function writeExecutable(body: string, mode = 0o755): string {
  const binary = join(mkdtempSync(join(tmpdir(), "plugin-binary-process-")), "reporter");
  writeFileSync(binary, body);
  chmodSync(binary, mode);
  return binary;
}

describe("asking a downloaded binary for its version", () => {
  it("reports the wait it really sat through rather than the one it asked for", async () => {
    const check = await reportedVersion(writeExecutable("#!/bin/sh\nsleep 30\n"), 700);
    const seconds = check.ok ? 0 : (check.failure as { seconds: number }).seconds;
    expect(seconds).toBeGreaterThanOrEqual(0.6);
    expect(seconds).toBeLessThan(2);
    expect(failureKind({ killed: true }, 1_234)).toEqual({ kind: "timeout", seconds: 1.2 });
  }, 20_000);

  it("reports why a binary could not be started at all", async () => {
    const binary = writeExecutable("#!/bin/sh\necho 0.6.0\n", 0o644);
    await expect(reportedVersion(binary, 5_000)).resolves.toEqual({
      ok: false,
      failure: { kind: "start", detail: "EACCES" },
    });
  });
});

const FAILURES: ReadonlyArray<readonly [unknown, VersionCheckFailure]> = [
  [{ code: "ENOENT" }, { kind: "start", detail: "ENOENT" }],
  [
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    { kind: "unclear", detail: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
  ],
  [new Error("spawn went wrong"), { kind: "unclear", detail: "spawn went wrong" }],
];

describe("working out what went wrong", () => {
  it.each(FAILURES)("reads %o without guessing", (error, expected) => {
    expect(failureKind(error, 10)).toEqual(expected);
  });
});
