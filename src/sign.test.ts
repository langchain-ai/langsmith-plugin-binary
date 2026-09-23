import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { APPLE_CREDENTIALS } from "./constants.js";
import { sign } from "./sign.js";

const EVERY_CREDENTIAL = Object.fromEntries(APPLE_CREDENTIALS.map((name) => [name, "set"]));

function codexConfig() {
  return loadConfig(new URL("../test/fixtures/codex/binary.config.json", import.meta.url).pathname);
}

describe("signing a binary", () => {
  it("stops loudly instead of shipping something unsigned", async () => {
    await expect(sign(codexConfig(), { env: {}, log: () => {} })).rejects.toThrow(
      "these Apple credentials are not set: APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_ID, CSC_KEY_PASSWORD, CSC_LINK",
    );
  });

  it("names the one credential that is missing", async () => {
    await expect(
      sign(codexConfig(), { env: { ...EVERY_CREDENTIAL, CSC_LINK: "" }, log: () => {} }),
    ).rejects.toThrow("these Apple credentials are not set: CSC_LINK");
  });

  it("stops when the build left no binary where it was told to look", async () => {
    await expect(
      sign(codexConfig(), { env: EVERY_CREDENTIAL, binaryPath: "/nowhere/binary", log: () => {} }),
    ).rejects.toThrow("there is no binary to sign at /nowhere/binary");
  });
});
