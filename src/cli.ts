#!/usr/bin/env node
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "./build.js";
import { loadConfig } from "./config.js";
import { renderInstaller } from "./install-script.js";
import type { LoadedConfig } from "./models.js";
import { sign } from "./sign.js";
import { describe } from "./utils/errors.js";

const COMMANDS = ["installer", "build", "sign"] as const;

const USAGE = `Usage: langsmith-plugin-binary <command> [--config <path>]

  installer          Write the repository's install script from its binary config.
                     --check compares the committed file instead of writing it.
  build [--arch=X]   Compile the plugin into a macOS binary. --arch=all builds both.
  sign [<binary>]    Sign and notarize a built binary with Apple.
`;

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) throw new Error(`${flag} needs a value`);
  return value;
}

function binaryToSign(argv: string[]): string | undefined {
  const flag = argv.indexOf("--config");
  const rest = flag < 0 ? argv : [...argv.slice(0, flag), ...argv.slice(flag + 2)];
  return rest.find((argument) => !argument.startsWith("-"));
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

export function entrypointPath(argv1: string): string {
  try {
    return realpathSync(resolve(argv1));
  } catch {
    return resolve(argv1);
  }
}

export async function run(argv: string[], log: (line: string) => void): Promise<void> {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) throw new Error(USAGE);

  const loaded = loadConfig(flagValue(rest, "--config") ?? "binary.config.json");
  if (command === "installer") return runInstallerCommand(loaded, rest, log);
  if (command === "build") return build(loaded, rest, log);

  await sign(loaded, { binaryPath: binaryToSign(rest), log });
}

if (process.argv[1] && import.meta.filename === entrypointPath(process.argv[1])) {
  run(process.argv.slice(2), (line) => console.log(line)).catch((error: unknown) => {
    console.error(describe(error));
    process.exit(1);
  });
}
