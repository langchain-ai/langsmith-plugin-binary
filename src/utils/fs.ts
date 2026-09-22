import type * as fs from "node:fs/promises";

export async function writeFully(handle: fs.FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset);
    if (bytesWritten === 0) throw new Error("could not write the release asset");
    offset += bytesWritten;
  }
}
