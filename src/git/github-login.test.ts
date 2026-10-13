import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createGitHubLoginFallback } from "./github-login.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const root = mkdtempSync(join(tmpdir(), "plugins-base gh login "));
const markerPath = join(root, "custom state", "login marker.json");

afterEach(() => vi.resetAllMocks());

it("uses its configured marker and retries a failed GitHub lookup only after the quiet period", () => {
  const now = 1_800_000_000_000;
  const lookup = vi.mocked(execFileSync).mockReturnValue("null");
  const failedLookup = createGitHubLoginFallback({ markerPath, now: () => now });

  expect(failedLookup()).toBeUndefined();
  expect(existsSync(markerPath)).toBe(true);
  expect(lookup).toHaveBeenCalledWith("gh", ["api", "user", "--jq", ".login"], {
    encoding: "utf-8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });

  const duringQuietPeriod = createGitHubLoginFallback({ markerPath, now: () => now + 1_000 });
  expect(duringQuietPeriod()).toBeUndefined();
  expect(lookup).toHaveBeenCalledTimes(1);

  lookup.mockReturnValue("recovered-user");
  const afterQuietPeriod = createGitHubLoginFallback({
    markerPath,
    now: () => now + 24 * 60 * 60 * 1000 + 1,
  });
  expect(afterQuietPeriod()).toBe("recovered-user");
  expect(afterQuietPeriod()).toBe("recovered-user");
  expect(lookup).toHaveBeenCalledTimes(2);
});
