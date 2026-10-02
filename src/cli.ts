#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "./build.js";
import { loadConfig } from "./config.js";
import { sign } from "./sign.js";
import { describe } from "./utils/errors.js";

const COMMANDS = ["build", "sign"] as const;

const USAGE = `Usage: langsmith-plugin-binary <command> [--config <path>]

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
  if (command === "build") return build(loaded, rest, log);

  await sign(loaded, { binaryPath: binaryToSign(rest), log });
}

if (process.argv[1] && import.meta.filename === entrypointPath(process.argv[1])) {
  run(process.argv.slice(2), (line) => console.log(line)).catch((error: unknown) => {
    console.error(describe(error));
    process.exit(1);
  });
}
