import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOOK_ERROR_HANDLER_WARNING, HOOK_OPTIONS_INVALID_MESSAGE } from "./constants.js";
import { commandReplyContext, dispatchHookCommand } from "./hook-command.js";
import type { HookCommandOptions } from "./models.js";

const log = vi.spyOn(console, "log");
let hook: ReturnType<typeof vi.fn<() => Promise<void>>>;
let worker: ReturnType<typeof vi.fn<(args: readonly string[]) => Promise<void>>>;
let onHookError: ReturnType<typeof vi.fn<(name: string, error: unknown) => void>>;
let onUnknown: ReturnType<typeof vi.fn<(argument: string | undefined) => void>>;

beforeEach(() => {
  log.mockImplementation(() => undefined);
  hook = vi.fn(async () => undefined);
  worker = vi.fn(async () => undefined);
  onHookError = vi.fn();
  onUnknown = vi.fn();
});

afterEach(() => log.mockReset());

const options = (): HookCommandOptions => ({
  usage: "usage text",
  version: "1.2.3",
  hooks: { Stop: hook },
  worker: { command: "--engine-worker", run: worker },
  onHookError,
  onUnknown,
});

it.each(["--help", "-h"])("prints the usage for %s and runs nothing", async (flag) => {
  await dispatchHookCommand([flag, "Stop"], options());
  expect(log).toHaveBeenCalledWith("usage text");
  expect(hook).not.toHaveBeenCalled();
});

it.each(["--version", "-v"])("prints the version for %s", async (flag) => {
  await dispatchHookCommand([flag], options());
  expect(log).toHaveBeenCalledWith("1.2.3");
});

it("runs the hook named by the first argument", async () => {
  await dispatchHookCommand(["Stop"], options());
  expect(hook).toHaveBeenCalledTimes(1);
  expect(onUnknown).not.toHaveBeenCalled();
});

it("runs the worker with the arguments that follow its command", async () => {
  await dispatchHookCommand(["--engine-worker", "/repo", "session-1"], options());
  expect(worker).toHaveBeenCalledWith(["/repo", "session-1"]);
});

it("reports a failing hook or worker without throwing", async () => {
  hook.mockRejectedValueOnce(new Error("hook broke"));
  worker.mockRejectedValueOnce(new Error("worker broke"));
  await dispatchHookCommand(["Stop"], options());
  await dispatchHookCommand(["--engine-worker"], options());
  expect(onHookError.mock.calls.map(([name, error]) => [name, String(error)])).toEqual([
    ["Stop", "Error: hook broke"],
    ["--engine-worker", "Error: worker broke"],
  ]);
});

it.each([[[]], [["Nope"]], [["constructor"]]])("treats %j as unknown", async (argv) => {
  await dispatchHookCommand(argv, options());
  expect(onUnknown).toHaveBeenCalledWith(argv[0]);
  expect(hook).not.toHaveBeenCalled();
});

it("treats the worker command as unknown when no worker is configured", async () => {
  const { worker: _worker, ...withoutWorker } = options();
  await dispatchHookCommand(["--engine-worker"], withoutWorker);
  expect(onUnknown).toHaveBeenCalledWith("--engine-worker");
});

it("warns instead of rejecting when the error handler itself fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  hook.mockRejectedValueOnce(new Error("hook broke"));
  onHookError.mockImplementationOnce(() => {
    throw new Error("handler broke");
  });
  await expect(dispatchHookCommand(["Stop"], options())).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(HOOK_ERROR_HANDLER_WARNING, "handler broke");
  warn.mockRestore();
});

it("rejects options without a hooks table before running anything", async () => {
  const { hooks: _hooks, ...withoutHooks } = options();
  await expect(
    dispatchHookCommand(["Stop"], withoutHooks as unknown as HookCommandOptions),
  ).rejects.toThrow(HOOK_OPTIONS_INVALID_MESSAGE);
});

it("hands the model a command reply that starts with the marker hook readers skip", () => {
  expect(commandReplyContext("Thread tracing muted.")).toBe(
    "[LangSmith tracing command] The user ran a LangSmith tracing command and the plugin already handled it. Reply with exactly the text below and nothing else:\n\nThread tracing muted.",
  );
});
