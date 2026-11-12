import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECORDED_EVENTS } from "./constants.ts";
import type { HookGroup, Scenario, Workspace } from "./models.ts";
import { quoteForShell } from "./utils/text.ts";

export function createWorkspace(workDir: string, scenario: Scenario): Workspace {
  const home = join(workDir, "home");
  const project = join(workDir, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  for (const [name, content] of Object.entries(scenario.files)) {
    writeFileSync(join(project, name), content);
  }
  return { home, project, eventsFile: join(workDir, "events.log") };
}

export function recorderHooks(eventsFile: string): Record<string, HookGroup[]> {
  return Object.fromEntries(
    RECORDED_EVENTS.map((event) => {
      const command = `cat > /dev/null; echo ${event} >> ${quoteForShell(eventsFile)}`;
      return [event, [{ hooks: [{ type: "command", command }] }]];
    }),
  );
}

export function baseEnvironment(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  };
}

export function readEvents(eventsFile: string): string[] {
  return existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").split("\n").filter(Boolean) : [];
}
