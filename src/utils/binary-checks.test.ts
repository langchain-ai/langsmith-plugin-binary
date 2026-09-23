import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBuiltArch, checkReportedVersion, lipoArches, machOArch } from "./binary-checks.js";

function writeVersionReporter(version: string): string {
  const binary = join(mkdtempSync(join(tmpdir(), "plugin-binary-build-")), "reporter");
  writeFileSync(binary, `#!/bin/sh\necho ${version}\n`);
  chmodSync(binary, 0o755);
  return binary;
}

describe("naming the chip for lipo", () => {
  it("translates each published chip", () => {
    expect(machOArch("arm64")).toBe("arm64");
    expect(machOArch("x64")).toBe("x86_64");
  });

  it("refuses a chip it has no name for", () => {
    expect(() => machOArch("ia32")).toThrow("No Mach-O architecture is known for ia32");
  });
});

describe("checking what came out of the build", () => {
  it("accepts a binary holding the chip it was asked for", () => {
    expect(() => checkBuiltArch("built", "x64", () => "x86_64")).not.toThrow();
  });

  it("refuses a binary built for the other chip", () => {
    expect(() => checkBuiltArch("built", "arm64", () => "x86_64")).toThrow(
      "The arm64 build produced x86_64, not arm64",
    );
  });

  it("refuses a binary holding both chips", () => {
    expect(() => checkBuiltArch("built", "arm64", () => "x86_64 arm64")).toThrow(
      "produced x86_64 arm64",
    );
  });

  it.runIf(process.platform === "darwin")("reads the chips out of a real binary", () => {
    expect(lipoArches("/bin/ls").split(" ")).toSatisfy((arches: string[]) =>
      arches.every((arch) => /^(arm64e?|x86_64|i386)$/.test(arch)),
    );
  });

  it("accepts a binary reporting the version being released", () => {
    const binary = writeVersionReporter("0.3.1");
    expect(() => checkReportedVersion(binary, "0.3.1")).not.toThrow();
  });

  it("refuses a binary reporting a different version", () => {
    const binary = writeVersionReporter("development");
    expect(() => checkReportedVersion(binary, "0.3.1")).toThrow(
      "reports version development, expected 0.3.1",
    );
  });
});
