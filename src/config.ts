import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ENVIRONMENT_PREFIX, EXECUTABLE_NAME, REPOSITORY_PATH } from "./constants.js";
import type { InstallerConfig, LoadedConfig, PluginBinaryConfig } from "./models.js";
import { describe } from "./utils/errors.js";
import { Section } from "./utils/validation.js";

function parseInstaller(root: Section): InstallerConfig {
  const installer = root.section("installer");
  return {
    productName: installer.text("productName"),
    shortUrl: installer.text("shortUrl"),
    environmentPrefix: installer.matching(
      "environmentPrefix",
      ENVIRONMENT_PREFIX,
      "an upper-case shell variable name",
    ),
    output: installer.repositoryPath("output"),
    helpFooter: installer.lines("helpFooter"),
    unsupportedPlatformHelp: installer.lines("unsupportedPlatformHelp"),
  };
}

export function parseConfig(raw: unknown): PluginBinaryConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("the binary config must be a JSON object");
  }
  const root = new Section(raw as Record<string, unknown>);
  return {
    executableName: root.matching(
      "executableName",
      EXECUTABLE_NAME,
      "a lower-case name made of letters, digits and single dashes",
    ),
    repository: root.matching("repository", REPOSITORY_PATH, "an owner/name repository path"),
    installer: parseInstaller(root),
  };
}

export function loadConfig(configPath: string): LoadedConfig {
  const absolute = resolve(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolute, "utf-8"));
  } catch (error) {
    throw new Error(`could not read the binary config at ${absolute}: ${describe(error)}`, {
      cause: error,
    });
  }
  return { config: parseConfig(raw), repositoryRoot: dirname(absolute) };
}
