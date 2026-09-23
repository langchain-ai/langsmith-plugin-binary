import { describe, expect, it, vi } from "vitest";
import { CODESIGN_TIMEOUT_MS } from "./constants.js";
import { verifyAdHocSignature } from "./download.js";

interface LaunchedProcess {
  file: string;
  args: string[];
  options: { timeout?: number };
}

const launched = vi.hoisted(() => ({ processes: [] as LaunchedProcess[] }));

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    options: { timeout?: number },
    done: (error: Error | null) => void,
  ) => {
    launched.processes.push({ file, args, options });
    done(null);
  },
}));

describe("checking the signature on a downloaded binary", () => {
  it("asks codesign to strictly verify the binary that was just downloaded", async () => {
    await verifyAdHocSignature("/tmp/plugin-binary/langsmith-codex-tracing");
    expect(launched.processes).toEqual([
      {
        file: "/usr/bin/codesign",
        args: ["--verify", "--strict", "/tmp/plugin-binary/langsmith-codex-tracing"],
        options: { timeout: CODESIGN_TIMEOUT_MS },
      },
    ]);
  });
});
