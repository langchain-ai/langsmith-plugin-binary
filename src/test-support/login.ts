import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function writeLoginConfig(profile: Record<string, unknown>, configPath?: string): string {
  const path = configPath ?? join(temporaryFolder("langsmith login "), "config.json");
  writeFileSync(path, JSON.stringify({ current_profile: "work", profiles: { work: profile } }));
  return path;
}

export function fakeTool(
  name: string,
  script = "",
  folder = temporaryFolder("fake tools "),
): string {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return folder;
}

export function temporaryFolder(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
