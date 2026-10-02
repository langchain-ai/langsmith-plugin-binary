import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function readVersion(repositoryRoot: string, versionFile: string): string {
  const parsed = JSON.parse(readFileSync(resolve(repositoryRoot, versionFile), "utf-8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error(`${versionFile} declares no version`);
  }
  return parsed.version;
}
