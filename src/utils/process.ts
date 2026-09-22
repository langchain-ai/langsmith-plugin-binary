import { execFile } from "node:child_process";
import { VERSION_CHECK_TIMEOUT_MS } from "../constants.js";

export function reportedVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      { encoding: "utf-8", timeout: VERSION_CHECK_TIMEOUT_MS },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}
