import { execFile, execFileSync } from "node:child_process";
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

export function signAdHoc(binary: string): void {
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", binary], { stdio: "inherit" });
}

export const security = (args: string[]): string =>
  execFileSync("/usr/bin/security", args, { encoding: "utf-8" });

export const codesign = (args: string[]): void => {
  execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
};

export function securityWithoutEchoingCredentials(args: string[], failure: string): void {
  try {
    execFileSync("/usr/bin/security", args, { stdio: "ignore" });
  } catch {
    throw new Error(`could not ${failure}`);
  }
}
