import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_TIMEOUT_MS } from "../constants.ts";
import type { HooksFile } from "../models.ts";

export function pluginHookCommands(pluginDir: string): Map<string, string[]> {
  const file = JSON.parse(
    readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8"),
  ) as HooksFile;
  return new Map(
    Object.entries(file.hooks).map(([event, groups]) => [
      event,
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    ]),
  );
}

export function runHookCommand(
  command: string,
  payload: string,
  cwd: string,
  env: Record<string, string>,
): Promise<number | null> {
  const child = spawn("sh", ["-c", command], {
    cwd,
    env,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: HOOK_TIMEOUT_MS,
  });
  child.stdin.end(payload);
  return new Promise((done) => child.on("close", done));
}
