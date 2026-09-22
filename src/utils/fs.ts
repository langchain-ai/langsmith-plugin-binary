import { readFileSync } from "node:fs";
import type * as fs from "node:fs/promises";
import { resolve } from "node:path";

export async function writeFully(handle: fs.FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset);
    if (bytesWritten === 0) throw new Error("could not write the release asset");
    offset += bytesWritten;
  }
}

export function readVersion(repositoryRoot: string, versionFile: string): string {
  const parsed = JSON.parse(readFileSync(resolve(repositoryRoot, versionFile), "utf-8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error(`${versionFile} declares no version`);
  }
  return parsed.version;
}
