import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { CAPTURE_DIRECTORY_MODE, CAPTURE_FILE_MODE } from "../constants.js";

export async function ensurePrivateDirectory(root: string, segments: string[]): Promise<string> {
  await mkdir(root, { recursive: true, mode: CAPTURE_DIRECTORY_MODE });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Capture root must be a real directory");
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: CAPTURE_DIRECTORY_MODE });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Capture path contains a non-directory");
    await chmod(current, CAPTURE_DIRECTORY_MODE);
    const checked = await lstat(current);
    if (!checked.isDirectory() || checked.isSymbolicLink())
      throw new Error("Capture path changed during setup");
  }
  return current;
}

export async function publishExclusive(
  path: string,
  contents: string,
  beforeCommit?: () => void,
): Promise<boolean> {
  const directory = dirname(path);
  const stagingPath = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(stagingPath, "wx", CAPTURE_FILE_MODE);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.chmod(CAPTURE_FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    beforeCommit?.();
    await link(stagingPath, path);
    await syncDirectory(directory);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(stagingPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

export async function readPrivateFile(root: string, path: string): Promise<string | undefined> {
  if (!(await hasRealParentDirectories(root, path))) return undefined;
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Capture record must be a regular file");
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Capture record must be a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function hasRealParentDirectories(root: string, path: string): Promise<boolean> {
  const relativeDirectory = relative(root, dirname(path));
  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeDirectory)
  ) {
    throw new Error("Capture path is outside storage root");
  }
  const directories = [root];
  let current = root;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = join(current, segment);
    directories.push(current);
  }
  for (const directory of directories) {
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Capture path contains a non-directory");
  }
  return true;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
