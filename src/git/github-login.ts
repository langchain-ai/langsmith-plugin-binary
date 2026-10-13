import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GH_LOGIN_RETRY_AFTER_MS } from "./constants.js";
import { githubLoginLookup, isGitHubLogin } from "./repository.js";
import type { GitHubLoginMarker, GitHubLoginOptions } from "./models.js";

export function createGitHubLoginFallback(options: GitHubLoginOptions): () => string | undefined {
  const now = options.now ?? Date.now;
  const retryAfterMs = options.retryAfterMs ?? GH_LOGIN_RETRY_AFTER_MS;
  let alreadyTried = false;
  let login: string | undefined;

  function failedRecently(): boolean {
    try {
      const marker = JSON.parse(readFileSync(options.markerPath, "utf-8")) as GitHubLoginMarker;
      const failed = new Date(marker.failed).getTime();
      const since = now() - failed;
      return since >= 0 && since < retryAfterMs;
    } catch {
      return false;
    }
  }

  function recordFailure(): void {
    try {
      mkdirSync(dirname(options.markerPath), { recursive: true });
      const partial = `${options.markerPath}.${process.pid}`;
      const marker: GitHubLoginMarker = { failed: new Date(now()).toISOString() };
      writeFileSync(partial, JSON.stringify(marker));
      renameSync(partial, options.markerPath);
    } catch {}
  }

  return () => {
    if (alreadyTried) return login;
    alreadyTried = true;
    if (failedRecently()) return undefined;
    try {
      const printed = githubLoginLookup();
      if (isGitHubLogin(printed)) login = printed;
    } catch {}
    if (login === undefined) recordFailure();
    return login;
  };
}
