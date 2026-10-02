import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { entrypointPath, run } from "./cli.js";
import { APPLE_CREDENTIALS } from "./constants.js";

function fixture(file: string): string {
  return new URL(`../test/fixtures/codex/${file}`, import.meta.url).pathname;
}

describe("signing from the command line", () => {
  afterEach(() => {
    for (const name of APPLE_CREDENTIALS) delete process.env[name];
  });

  it("signs the built binary, not the config file it was pointed at", async () => {
    for (const name of APPLE_CREDENTIALS) process.env[name] = "set";
    await expect(
      run(["sign", "--config", fixture("binary.config.json")], () => {}),
    ).rejects.toThrow(
      `there is no binary to sign at ${fixture("plugins/tracing/bin/langsmith-codex-tracing")}`,
    );
  });
});

describe("running a command", () => {
  it("refuses one it does not have", async () => {
    await expect(run(["publish"], () => {})).rejects.toThrow("Usage");
  });

  it("refuses a config flag with nothing after it", async () => {
    await expect(run(["build", "--config"], () => {})).rejects.toThrow("--config needs a value");
  });

  it("says where it looked when the config is not there", async () => {
    await expect(
      run(["build", "--config", "/nowhere/binary.config.json"], () => {}),
    ).rejects.toThrow("could not read the binary config at /nowhere/binary.config.json");
  });
});

describe("the entrypoint check", () => {
  it("sees through the symlink a package manager installs the bin as", () => {
    const real = join(mkdtempSync(join(tmpdir(), "entry-")), "cli.js");
    writeFileSync(real, "");
    const link = `${real}.link`;
    symlinkSync(real, link);

    expect(entrypointPath(link)).toBe(realpathSync(real));
  });

  it("falls back to the given path when nothing is there to resolve", () => {
    const missing = join(tmpdir(), "entry-missing", "cli.js");

    expect(entrypointPath(missing)).toBe(missing);
  });
});
