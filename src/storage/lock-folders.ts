import { removeEmptyAncestors } from "../utils/files/cleanup.js";
import { FILE_LOCK_DIRECTORY_SUFFIX } from "./constants.js";

export async function removeEmptyLockFolders(lockPath: string, root: string): Promise<void> {
  await removeEmptyAncestors(`${lockPath}${FILE_LOCK_DIRECTORY_SUFFIX}`, root);
}
