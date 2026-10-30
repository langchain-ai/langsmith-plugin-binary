import { readFileSync, statSync, type Stats } from "node:fs";

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

export function fileStats(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
