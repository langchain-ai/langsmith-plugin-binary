import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMON_CONFIG_FILE_NAME,
  COMMON_CONFIG_OPEN_FLAGS,
  COMMON_CONFIG_ROOT_FILE_NAME,
  COMMON_CONFIG_USER_ROOT_FILE_NAME,
} from "./constants.js";
import { readManagedConfigFile } from "./managed-config.js";
import type { CommonConfigFileOptions, CommonConfigFiles, CommonConfigResult } from "./models.js";
import { absent, invalid, parseCommonConfig } from "./parse.js";

/** Follow readable symlinks, but never read directories/devices/FIFOs. Only true ENOENT is absent. */
export function readCommonConfigFile(path: string): CommonConfigResult {
  let fd: number;
  try {
    fd = openSync(path, COMMON_CONFIG_OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        lstatSync(path);
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code === "ENOENT") {
          return absent();
        }
      }
    }
    return invalid();
  }
  try {
    if (!fstatSync(fd).isFile()) return invalid();
    return parseCommonConfig(JSON.parse(readFileSync(fd, "utf8")));
  } catch {
    return invalid();
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

export function readCommonConfigFiles(options: CommonConfigFileOptions): CommonConfigFiles {
  const { cwd, home, harnessDirectory } = options;
  return {
    harness: readCommonConfigFile(join(cwd, harnessDirectory, COMMON_CONFIG_FILE_NAME)),
    root: readCommonConfigFile(join(cwd, COMMON_CONFIG_ROOT_FILE_NAME)),
    user: home
      ? readCommonConfigFile(join(home, harnessDirectory, COMMON_CONFIG_FILE_NAME))
      : absent(),
    userRoot: home ? readCommonConfigFile(join(home, COMMON_CONFIG_USER_ROOT_FILE_NAME)) : absent(),
    managed: readManagedConfigFile(options.managed),
  };
}
