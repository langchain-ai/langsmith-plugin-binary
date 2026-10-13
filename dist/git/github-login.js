import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GH_LOGIN_RETRY_AFTER_MS } from "./constants.js";
import { githubLoginLookup, isGitHubLogin } from "./repository.js";
export function createGitHubLoginFallback(options) {
    const now = options.now ?? Date.now;
    const retryAfterMs = options.retryAfterMs ?? GH_LOGIN_RETRY_AFTER_MS;
    let alreadyTried = false;
    let login;
    function failedRecently() {
        try {
            const marker = JSON.parse(readFileSync(options.markerPath, "utf-8"));
            const failed = new Date(marker.failed).getTime();
            const since = now() - failed;
            return since >= 0 && since < retryAfterMs;
        }
        catch {
            return false;
        }
    }
    function recordFailure() {
        try {
            mkdirSync(dirname(options.markerPath), { recursive: true });
            const partial = `${options.markerPath}.${process.pid}`;
            const marker = { failed: new Date(now()).toISOString() };
            writeFileSync(partial, JSON.stringify(marker));
            renameSync(partial, options.markerPath);
        }
        catch { }
    }
    return () => {
        if (alreadyTried)
            return login;
        alreadyTried = true;
        if (failedRecently())
            return undefined;
        try {
            const printed = githubLoginLookup();
            if (isGitHubLogin(printed))
                login = printed;
        }
        catch { }
        if (login === undefined)
            recordFailure();
        return login;
    };
}
//# sourceMappingURL=github-login.js.map