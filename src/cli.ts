#!/usr/bin/env node
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { renderInstaller } from "./install-script.js";
import type { LoadedConfig } from "./models.js";
import { describe } from "./utils/errors.js";

const COMMANDS = ["installer"] as const;

const USAGE = `Usage: langsmith-plugin-binary <command> [--config <path>]

  installer          Write the repository's install script from its binary config.
                     --check compares the committed file instead of writing it.
`;

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) throw new Error(`${flag} needs a value`);
  return value;
}

function runInstallerCommand(
  loaded: LoadedConfig,
  argv: string[],
  log: (line: string) => void,
): void {
  const target = resolve(loaded.repositoryRoot, loaded.config.installer.output);
  const rendered = renderInstaller(loaded.config);

  if (!argv.includes("--check")) {
    writeFileSync(target, rendered);
    chmodSync(target, 0o755);
    log(`Wrote ${target}`);
    return;
  }

  const committed = readFileSync(target, "utf-8");
  if (committed !== rendered) {
    throw new Error(
      `${target} does not match the generator. Run the installer command and commit the result.`,
    );
  }
  log(`${target} matches the generator`);
}

export async function run(argv: string[], log: (line: string) => void): Promise<void> {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) throw new Error(USAGE);

  const loaded = loadConfig(flagValue(rest, "--config") ?? "binary.config.json");
  runInstallerCommand(loaded, rest, log);
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  run(process.argv.slice(2), (line) => console.log(line)).catch((error: unknown) => {
    console.error(describe(error));
    process.exit(1);
  });
}
