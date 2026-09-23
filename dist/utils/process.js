import { execFile, execFileSync } from "node:child_process";
import { VERSION_CHECK_TIMEOUT_MS } from "../constants.js";
export function reportedVersion(executable) {
    return new Promise((resolve, reject) => {
        execFile(executable, ["--version"], { encoding: "utf-8", timeout: VERSION_CHECK_TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
    });
}
export function signAdHoc(binary) {
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", binary], { stdio: "inherit" });
}
export const security = (args) => execFileSync("/usr/bin/security", args, { encoding: "utf-8" });
export const codesign = (args) => {
    execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
};
export function securityWithoutEchoingCredentials(args, failure) {
    try {
        execFileSync("/usr/bin/security", args, { stdio: "ignore" });
    }
    catch {
        throw new Error(`could not ${failure}`);
    }
}
//# sourceMappingURL=process.js.map