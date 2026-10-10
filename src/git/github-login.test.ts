import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createGitHubLoginFallback } from "./github-login.js";

const root = mkdtempSync(join(tmpdir(), "plugins-base gh login "));
const bin = join(root, "bin");
const argsPath = join(root, "gh args");
const markerPath = join(root, "custom state", "login marker.json");

beforeAll(() => {
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_PROBE_ARGS"\nprintf '%s\\n' "$GH_PROBE_OUTPUT"\n`,
    { mode: 0o755 },
  );
});

afterEach(() => vi.unstubAllEnvs());

it("uses its configured marker and retries a failed GitHub lookup only after the quiet period", () => {
  const now = 1_800_000_000_000;
  vi.stubEnv("HOME", root);
  vi.stubEnv("PATH", bin);
  vi.stubEnv("GH_PROBE_ARGS", argsPath);
  vi.stubEnv("GH_PROBE_OUTPUT", "null");
  const failedLookup = createGitHubLoginFallback({ markerPath, now: () => now });

  expect(failedLookup()).toBeUndefined();
  expect(existsSync(markerPath)).toBe(true);
  expect(readFileSync(argsPath, "utf-8").trim()).toBe("api user --jq .login");

  const duringQuietPeriod = createGitHubLoginFallback({ markerPath, now: () => now + 1_000 });
  expect(duringQuietPeriod()).toBeUndefined();
  expect(readFileSync(argsPath, "utf-8").trim().split("\n")).toHaveLength(1);

  vi.stubEnv("GH_PROBE_OUTPUT", "recovered-user");
  const afterQuietPeriod = createGitHubLoginFallback({
    markerPath,
    now: () => now + 24 * 60 * 60 * 1000 + 1,
  });
  expect(afterQuietPeriod()).toBe("recovered-user");
  expect(afterQuietPeriod()).toBe("recovered-user");
  expect(readFileSync(argsPath, "utf-8").trim().split("\n")).toHaveLength(2);
});
