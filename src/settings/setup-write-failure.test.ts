import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: () => {
      throw Object.assign(new Error("rename failed"), { code: "EBUSY" });
    },
  };
});

const { writeSetupConfig } = await import("./index.js");

describe("a setup write that fails after the temp file exists", () => {
  it("removes the temp copy of the settings and leaves the original alone", () => {
    const root = fs.mkdtempSync(join(tmpdir(), "plugins base setup failure "));
    const directory = join(root, ".harness");
    fs.mkdirSync(directory);
    fs.writeFileSync(join(directory, "langsmith.json"), '{"api_key":"lsv2_keep"}');
    expect(() => writeSetupConfig(root, ".harness", { project: "demo" })).toThrow("(EBUSY)");
    expect(fs.readdirSync(directory)).toEqual(["langsmith.json"]);
    expect(fs.readFileSync(join(directory, "langsmith.json"), "utf8")).toBe(
      '{"api_key":"lsv2_keep"}',
    );
  });
});
