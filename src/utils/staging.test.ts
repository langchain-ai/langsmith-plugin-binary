import { describe, expect, it } from "vitest";
import { KERNEL_LOG_COMMAND } from "../constants.js";
import type { VersionCheckFailure } from "../models.js";
import {
  whyTheSignatureStoppedMatching,
  whyTheVersionCheckFailed,
  worthRetrying,
} from "./staging.js";

const STAGED = "/home/someone/.langsmith/.langsmith-codex-tracing.rejected";
const BLAME = /Apple ID|Gatekeeper|notari|security software|antivirus/i;

const EXPLANATIONS: ReadonlyArray<
  readonly [VersionCheckFailure, boolean, readonly string[], readonly string[]]
> = [
  [
    { kind: "stopped", signal: "SIGKILL" },
    true,
    ["killed the downloaded binary with SIGKILL", KERNEL_LOG_COMMAND, STAGED],
    [],
  ],
  [
    { kind: "crashed", signal: "SIGSEGV" },
    false,
    ["crashed with SIGSEGV", "the program itself failed rather than anything stopping it", STAGED],
    ["log show"],
  ],
  [
    { kind: "timeout", seconds: 10 },
    false,
    ["gave up waiting after 10 seconds", STAGED],
    ["log show"],
  ],
  [{ kind: "exit", status: 3 }, false, ["exited with code 3"], ["is kept at"]],
  [{ kind: "start", detail: "EACCES" }, false, ["could not be started (EACCES)", STAGED], []],
  [
    { kind: "unclear", detail: "buffer full" },
    false,
    ["did not report its version (buffer full)", STAGED],
    ["could not be started"],
  ],
];

describe("telling the user why the version check failed", () => {
  it.each(EXPLANATIONS)("explains a %o", (failure, retries, says, avoids) => {
    const message = whyTheVersionCheckFailed(failure, STAGED);
    for (const text of says) expect(message).toContain(text);
    for (const text of avoids) expect(message).not.toContain(text);
    for (const line of message.split("\n")) expect(line[0]).toBe(line[0]?.toUpperCase());
    expect(message).not.toMatch(BLAME);
    expect(worthRetrying(failure)).toBe(retries);
  });
});

describe("telling the user the file changed under us", () => {
  it("names the altering rather than the signature tool", () => {
    const message = whyTheSignatureStoppedMatching(new Error("not signed at all"), STAGED);
    for (const text of [
      "no longer matches the signature we published",
      "altered the file after it landed here",
      "not signed at all",
      STAGED,
    ]) {
      expect(message).toContain(text);
    }
    expect(message).not.toMatch(BLAME);
  });
});
