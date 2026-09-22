import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isVersion, isVersionNewer } from "./version.js";

const INSTALL_SCRIPT = new URL("../../test/fixtures/codex/install.sh", import.meta.url).pathname;

const LADDERS = [
  ["0.3.0", "0.4.0", "0.10.0"],
  ["0.5.0-beta.1", "0.5.0"],
  ["0.5.0-alpha.99", "0.5.0-beta.1", "0.5.0-beta.2", "0.5.0-beta.10"],
  ["0.4.0-beta", "0.4.0-beta.1"],
  ["0.4.0-beta", "0.4.0-beta.1", "0.4.0"],
  ["0.99.99", "1.0.0"],
];

function newestByInstallScript(versions: string[]): string {
  const sorting = readFileSync(INSTALL_SCRIPT, "utf-8")
    .split("\n")
    .join("\n")
    .match(/^newest_version\(\) \{[\s\S]*?^\}$/m);
  if (!sorting) throw new Error("the install script has no newest_version function");
  return execFileSync("/bin/bash", ["-c", `${sorting[0]}\nnewest_version`], {
    encoding: "utf-8",
    input: versions.join("\n"),
  }).trim();
}

function newestByUpdater(versions: string[]): string {
  return versions.reduce((newest, candidate) =>
    isVersionNewer(candidate, newest) ? candidate : newest,
  );
}

describe("ordering releases", () => {
  it.each(LADDERS)(
    "agrees with the install script about %s and the versions beside it",
    (...ladder) => {
      for (const order of [ladder, ladder.toReversed()]) {
        expect(newestByUpdater(order)).toBe(newestByInstallScript(order));
        expect(newestByUpdater(order)).toBe(ladder.at(-1));
      }
    },
  );

  it("agrees with the install script across every ladder at once", () => {
    const everything = LADDERS.flat();
    expect(newestByUpdater(everything)).toBe(newestByInstallScript(everything));
  });

  it("agrees with the install script about tags neither of them accepts", () => {
    for (const tag of ["v1.0.0", "1.0.0-Beta.1", "latest", "1.0", ""]) {
      expect(isVersion(tag)).toBe(false);
      expect(newestByInstallScript([tag, "0.4.0"])).toBe("0.4.0");
    }
  });
});
