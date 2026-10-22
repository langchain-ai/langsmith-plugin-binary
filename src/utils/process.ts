import { execFile, execFileSync } from "node:child_process";
import { CRASH_SIGNALS, NODE_ERROR_PREFIX } from "../constants.js";
import type { ExecFileFailure, VersionCheck, VersionCheckFailure } from "../models.js";
import { describe } from "./errors.js";

export function failureKind(error: unknown, elapsed: number): VersionCheckFailure {
  const { killed, signal, code } = (error ?? {}) as ExecFileFailure;
  if (killed) return { kind: "timeout", seconds: Math.round(elapsed / 100) / 10 };
  if (signal) return { kind: CRASH_SIGNALS.has(signal) ? "crashed" : "stopped", signal };
  if (typeof code === "number") return { kind: "exit", status: code };
  const refused = typeof code === "string" && !code.startsWith(NODE_ERROR_PREFIX);
  const detail = typeof code === "string" ? code : describe(error);
  return { kind: refused ? "start" : "unclear", detail };
}

export function reportedVersion(executable: string, timeout: number): Promise<VersionCheck> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      executable,
      ["--version"],
      { encoding: "utf-8", timeout, killSignal: "SIGKILL" },
      (error, stdout) =>
        resolve(
          error
            ? { ok: false, failure: failureKind(error, Date.now() - startedAt) }
            : { ok: true, reported: stdout.trim() },
        ),
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
