import { unlinkSync } from "node:fs";
import { ifMissing } from "./missing.js";

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    ifMissing(undefined)(error);
  }
}
