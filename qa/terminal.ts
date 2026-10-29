import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "@lydell/node-pty";
import {
  EXIT_WAIT_MS,
  HOOK_RETRY_ATTEMPTS,
  HOOK_RETRY_WAIT_MS,
  SCREEN_TAIL_CHARS,
  STARTUP_WAIT_MS,
  STOP_EVENT,
  TERMINAL_COLUMNS,
  TERMINAL_ROWS,
  TURN_TIMEOUT_MS,
} from "./constants.ts";
import type { AgentLaunch } from "./models.ts";
import { readEvents } from "./workspace.ts";

function countStops(eventsFile: string): number {
  return readEvents(eventsFile).filter((event) => event === STOP_EVENT).length;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(1_000);
  }
  return condition();
}

export async function driveTerminal(
  launch: AgentLaunch,
  prompts: string[],
  eventsFile: string,
): Promise<string[]> {
  const terminal = spawn(launch.command, launch.args, {
    name: "xterm-256color",
    cols: TERMINAL_COLUMNS,
    rows: TERMINAL_ROWS,
    cwd: launch.cwd,
    env: launch.env,
  });
  let screen = "";
  terminal.onData((data) => {
    screen += data;
  });
  const screenTail = () => stripVTControlCharacters(screen).slice(-SCREEN_TAIL_CHARS);

  const type = async (text: string) => {
    for (const key of text) {
      terminal.write(key);
      await sleep(launch.typing.keyDelayMs);
    }
    await sleep(launch.typing.enterDelayMs);
    terminal.write("\r");
  };

  const failures: string[] = [];
  await sleep(STARTUP_WAIT_MS);
  for (const [index, prompt] of prompts.entries()) {
    const stopsBefore = countStops(eventsFile);
    const eventsBefore = readEvents(eventsFile).length;
    await type(prompt);
    for (let attempt = 0; attempt < HOOK_RETRY_ATTEMPTS; attempt++) {
      if (await waitFor(() => readEvents(eventsFile).length > eventsBefore, HOOK_RETRY_WAIT_MS))
        break;
      terminal.write("\r");
    }
    if (!(await waitFor(() => countStops(eventsFile) > stopsBefore, TURN_TIMEOUT_MS))) {
      failures.push(
        `turn ${index + 1} never reached the Stop hook, screen ends with:\n${screenTail()}`,
      );
      break;
    }
  }

  await type(launch.exitCommand);
  await sleep(EXIT_WAIT_MS);
  terminal.kill();
  return failures;
}
