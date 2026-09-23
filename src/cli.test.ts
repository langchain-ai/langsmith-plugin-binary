import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { entrypointPath, run } from "./cli.js";
import { APPLE_CREDENTIALS } from "./constants.js";

function fixture(file: string): string {
  return new URL(`../test/fixtures/codex/${file}`, import.meta.url).pathname;
}

function consumerRepository(installer: string): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-binary-cli-"));
  cpSync(fixture("."), root, { recursive: true });
  writeFileSync(join(root, "install.sh"), installer);
  chmodSync(join(root, "install.sh"), 0o644);
  return root;
}

async function generate(root: string, ...flags: string[]): Promise<string[]> {
  const lines: string[] = [];
  await run(["installer", "--config", join(root, "binary.config.json"), ...flags], (line) =>
    lines.push(line),
  );
  return lines;
}

describe("generating a repository's install script", () => {
  it("writes the file the config names", async () => {
    const root = consumerRepository("stale\n");
    await generate(root);
    expect(readFileSync(join(root, "install.sh"), "utf-8")).toBe(
      readFileSync(fixture("install.sh"), "utf-8"),
    );
  });

  it("writes it so it can be run directly", async () => {
    const root = consumerRepository("stale\n");
    await generate(root);
    expect(statSync(join(root, "install.sh")).mode & 0o111).toBe(0o111);
  });

  it("reports a committed file that has drifted", async () => {
    const root = consumerRepository("stale\n");
    await expect(generate(root, "--check")).rejects.toThrow("does not match the generator");
  });

  it("accepts a committed file the generator would write", async () => {
    const root = consumerRepository(readFileSync(fixture("install.sh"), "utf-8"));
    await expect(generate(root, "--check")).resolves.toEqual([
      `${join(root, "install.sh")} matches the generator`,
    ]);
  });
});

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
    await expect(run(["installer", "--config"], () => {})).rejects.toThrow(
      "--config needs a value",
    );
  });

  it("says where it looked when the config is not there", async () => {
    await expect(
      run(["installer", "--config", "/nowhere/binary.config.json"], () => {}),
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
