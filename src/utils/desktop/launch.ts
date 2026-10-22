import { accessSync, constants, statSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { WINDOWS_PLATFORM } from "../constants.js";
import {
  DESKTOP_EXTENSIONS_VARIABLE,
  DESKTOP_PATH_VARIABLES,
  DESKTOP_PATH_SEPARATOR,
  DESKTOP_WINDOWS_EXTENSIONS,
  DESKTOP_WINDOWS_SEPARATOR,
} from "./desktop-constants.js";

export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const windows = platform === WINDOWS_PLATFORM;
  const extensions = windows
    ? (env[DESKTOP_EXTENSIONS_VARIABLE] ?? DESKTOP_WINDOWS_EXTENSIONS).split(
        DESKTOP_WINDOWS_SEPARATOR,
      )
    : [""];
  const path = DESKTOP_PATH_VARIABLES.map((variable) => env[variable]).find(
    (value) => value !== undefined,
  );
  const folders = (path ?? "").split(windows ? DESKTOP_WINDOWS_SEPARATOR : DESKTOP_PATH_SEPARATOR);
  const absolute = windows ? win32.isAbsolute : posix.isAbsolute;
  for (const folder of folders.filter((entry) => entry !== "" && absolute(entry))) {
    for (const extension of extensions) {
      const candidate = join(folder, `${name}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return undefined;
}
