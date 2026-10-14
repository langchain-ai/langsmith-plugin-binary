import { spawn } from "node:child_process";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { childEnvironment, moduleUrl } from "../test-support/tracing/delivery.js";
import { launchDetachedWorker } from "./worker-launch.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

let directory: string;
let recorder: string;
let output: string;
const originalArgv = [...process.argv];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "plugins base worker "));
  output = join(directory, "args.txt");
  recorder = join(directory, "record.sh");
  writeFileSync(
    recorder,
    `#!/bin/sh\nprintf '%s\\n' "$$" "$(ps -o pgid= -p $$ | tr -d ' ')" "$@" > "${output}"\necho "to stdout"\necho "to stderr" >&2\n`,
  );
  chmodSync(recorder, 0o755);
});

afterEach(() => {
  process.argv = [...originalArgv];
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

async function recorded(): Promise<string[]> {
  await vi.waitFor(() => expect(readFileSync(output, "utf8")).not.toBe(""), { timeout: 10_000 });
  return readFileSync(output, "utf8").trimEnd().split("\n");
}

it.skipIf(process.platform === "win32")(
  "starts the worker with the running script first and reports its process ID",
  async () => {
    process.argv[1] = "/plugins/hooks.mjs";
    const pid = await launchDetachedWorker(["--engine-worker", "session-1"], {
      executable: recorder,
    });
    const [childPid, , ...args] = await recorded();
    expect(Number(childPid)).toBe(pid);
    expect(args).toEqual(["/plugins/hooks.mjs", "--engine-worker", "session-1"]);
  },
);

it.skipIf(process.platform === "win32")(
  "starts a compiled binary with only the worker arguments",
  async () => {
    process.argv[1] = "/$bunfs/root/hooks.js";
    await launchDetachedWorker(["--engine-worker", "session-1"], { executable: recorder });
    expect((await recorded()).slice(2)).toEqual(["--engine-worker", "session-1"]);
  },
);

it.skipIf(process.platform === "win32")(
  "writes the worker's output to the log file when given one",
  async () => {
    const logFile = join(directory, "worker.log");
    await launchDetachedWorker(["x"], { executable: recorder, logFile });
    await recorded();
    await vi.waitFor(() => expect(readFileSync(logFile, "utf8")).toContain("to stderr"), {
      timeout: 10_000,
    });
    expect(readFileSync(logFile, "utf8")).toContain("to stdout");
  },
);

it.skipIf(process.platform === "win32")(
  "starts a plain script without a file extension as the first argument",
  async () => {
    process.argv[1] = "/plugins/bin/hooks";
    await launchDetachedWorker(["x"], { executable: recorder });
    expect((await recorded()).slice(2)).toEqual(["/plugins/bin/hooks", "x"]);
  },
);

it.skipIf(process.platform === "win32")("starts the worker in its own process group", async () => {
  const pid = await launchDetachedWorker(["x"], { executable: recorder });
  const [, groupId] = await recorded();
  expect(Number(groupId)).toBe(pid);
});

it("starts the worker without a console window and closes its own copy of the log", async () => {
  const spawned = vi.spyOn(childProcess, "spawn");
  const closed = vi.spyOn(fs, "closeSync");
  const logFile = join(directory, "worker.log");
  await launchDetachedWorker(["x"], { executable: recorder, logFile });
  const spawnOptions = spawned.mock.calls[0]?.[2] as { stdio: unknown[] };
  expect(spawnOptions).toMatchObject({ detached: true, windowsHide: true });
  expect(closed).toHaveBeenCalledWith(spawnOptions.stdio[1]);
});

it.skipIf(process.platform === "win32")("keeps the worker log private to its owner", async () => {
  const logFile = join(directory, "worker.log");
  await launchDetachedWorker(["x"], { executable: recorder, logFile });
  expect(statSync(logFile).mode & 0o777).toBe(0o600);
});

it.skipIf(process.platform === "win32")(
  "creates a missing log folder and keeps launching when the log cannot be opened",
  async () => {
    const nested = join(directory, "logs", "deeper", "worker.log");
    await launchDetachedWorker(["x"], { executable: recorder, logFile: nested });
    await recorded();
    await vi.waitFor(() => expect(readFileSync(nested, "utf8")).toContain("to stderr"));
    const blocked = join(directory, "args.txt", "worker.log");
    const pid = await launchDetachedWorker(["y"], { executable: recorder, logFile: blocked });
    expect(pid).toBeGreaterThan(0);
  },
);

it.skipIf(process.platform === "win32")(
  "starts a fresh log once the old one is too big",
  async () => {
    const logFile = join(directory, "worker.log");
    writeFileSync(logFile, "old\n".repeat(400_000));
    await launchDetachedWorker(["x"], { executable: recorder, logFile });
    await recorded();
    await vi.waitFor(() => expect(readFileSync(logFile, "utf8")).toContain("to stderr"));
    expect(readFileSync(logFile, "utf8")).not.toContain("old");
  },
);

it("rejects when the worker cannot be started", async () => {
  await expect(
    launchDetachedWorker(["x"], { executable: join(directory, "missing") }),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32")(
  "lets the starting process exit while the worker keeps running",
  async () => {
    const sleeper = join(directory, "sleep.sh");
    writeFileSync(sleeper, "#!/bin/sh\nsleep 8\n");
    chmodSync(sleeper, 0o755);
    const started = Date.now();
    await new Promise<void>((resolve) => {
      spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./fixtures/launch-and-exit.mjs", import.meta.url)),
          moduleUrl("dist/plugin/index.js"),
          sleeper,
        ],
        { env: childEnvironment(directory), stdio: "ignore" },
      ).once("exit", () => resolve());
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  },
);
