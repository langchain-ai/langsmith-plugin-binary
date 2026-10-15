import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCommonConfigFiles } from "./index.js";

function write(path: string, value: unknown): void {
  fs.mkdirSync(join(path, ".."), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value));
}

describe("reading the five common config files", () => {
  it("reads each file from its own place and keeps their results apart", () => {
    const cwd = fs.mkdtempSync(join(tmpdir(), "plugins base cwd "));
    const home = fs.mkdtempSync(join(tmpdir(), "plugins base home "));
    write(join(cwd, ".harness", "langsmith.json"), { project: "harness" });
    write(join(cwd, "langsmith-plugins.json"), { project: "root" });
    write(join(home, ".harness", "langsmith.json"), { project: "user" });
    write(join(home, ".langsmith-plugins.json"), { project: "user-root" });
    write(join(cwd, "managed.json"), { redact: true });
    const managed = { path: join(cwd, "managed.json"), checkOwnership: false };
    const files = readCommonConfigFiles({ cwd, home, harnessDirectory: ".harness", managed });
    expect(files.managed.common).toEqual({ redact: true });
    expect(Object.entries(files).map(([name, { common }]) => [name, common.project])).toEqual([
      ["harness", "harness"],
      ["root", "root"],
      ["user", "user"],
      ["userRoot", "user-root"],
      ["managed", undefined],
    ]);
  });

  it("reports missing files as absent and skips the home files without a home", () => {
    const cwd = fs.mkdtempSync(join(tmpdir(), "plugins base cwd "));
    write(join(cwd, ".harness", "langsmith.json"), { project: "harness" });
    const managed = { path: join(cwd, "managed.json") };
    const files = readCommonConfigFiles({
      cwd,
      home: undefined,
      harnessDirectory: ".harness",
      managed,
    });
    expect(Object.entries(files).map(([name, { status }]) => [name, status])).toEqual([
      ["harness", "valid"],
      ["root", "absent"],
      ["user", "absent"],
      ["userRoot", "absent"],
      ["managed", "absent"],
    ]);
  });
});
