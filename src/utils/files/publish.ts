import { closeSync, openSync, renameSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function publishByRename(
  path: string,
  contents: string,
  tempSuffix: string,
  mode: number,
): void {
  const temp = `${path}.${randomUUID()}${tempSuffix}`;
  const fd = openSync(temp, "wx", mode);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
