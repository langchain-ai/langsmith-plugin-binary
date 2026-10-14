import { open } from "node:fs/promises";

async function disableFileHandleSync(): Promise<void> {
  const handle = await open(process.execPath, "r");
  Object.getPrototypeOf(handle).sync = async () => undefined;
  await handle.close();
}

await disableFileHandleSync();
