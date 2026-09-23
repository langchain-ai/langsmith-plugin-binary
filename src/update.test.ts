import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptEverything,
  CODEX,
  executableBody,
  publish,
  recordRequests,
  RELEASES_API,
  scratchDirectory,
  serve,
  sha256,
} from "./test-support.js";
import type { PublishedRelease } from "./test-support.js";

const INSTALLED = "langsmith-codex-tracing";

function update(fetchImpl: typeof fetch, currentVersion: string, installDir: string) {
  return CODEX.update({ ...acceptEverything(), currentVersion, installDir, fetchImpl });
}

function updateFrom(releases: PublishedRelease[], currentVersion = "0.5.0") {
  return update(serve(releases), currentVersion, scratchDirectory());
}

async function failedUpdate(releases: PublishedRelease[]) {
  const installDir = scratchDirectory();
  const error = await update(serve(releases), "0.5.0", installDir).catch((thrown: Error) => thrown);
  return { installDir, message: (error as Error).message };
}

function firstRequestFor(options: Parameters<typeof CODEX.update>[0]) {
  const asked: string[] = [];
  return CODEX.update({ ...options, fetchImpl: recordRequests(asked) }).then(() => asked[0]);
}

describe("updating an installed binary", () => {
  it("installs a newer release", async () => {
    const installDir = scratchDirectory();
    const fetchImpl = serve([publish("0.5.0"), publish("0.4.0")]);
    await expect(update(fetchImpl, "0.4.0", installDir)).resolves.toEqual({
      status: "updated",
      version: "0.5.0",
    });
    expect(existsSync(join(installDir, INSTALLED))).toBe(true);
  });

  it("leaves the newest installed version alone", async () => {
    await expect(updateFrom([publish("0.5.0")])).resolves.toEqual({ status: "current" });
  });

  it("never downgrades to an older release", async () => {
    await expect(updateFrom([publish("0.4.0")])).resolves.toEqual({ status: "current" });
  });

  it("installs a release that only fixes the last number", async () => {
    await expect(updateFrom([publish("0.5.1")])).resolves.toEqual({
      status: "updated",
      version: "0.5.1",
    });
  });

  it("moves off a prerelease onto the release it led to", async () => {
    await expect(updateFrom([publish("0.6.0")], "0.6.0-beta.1")).resolves.toEqual({
      status: "updated",
      version: "0.6.0",
    });
  });

  it("takes this machine's binary from a release that publishes both", async () => {
    const installDir = scratchDirectory();
    const both = publish("0.6.0");
    const intel = publish("0.6.0", { arch: "x64" });
    (both.json.assets as unknown[]).unshift((intel.json.assets as unknown[])[0]);
    Object.assign(both.files, intel.files);
    await expect(update(serve([both]), "0.5.0", installDir)).resolves.toMatchObject({
      version: "0.6.0",
    });
    expect(readFileSync(join(installDir, INSTALLED), "utf-8")).toBe(executableBody("0.6.0"));
  });

  it("says so when GitHub answers with something that is not a release list", async () => {
    const fetchImpl = (async () => Response.json({ message: "Not Found" })) as typeof fetch;
    await expect(update(fetchImpl, "0.5.0", scratchDirectory())).rejects.toThrow(
      "no list of releases",
    );
  });

  it("leaves the install folder holding nothing but the binary", async () => {
    const installDir = scratchDirectory();
    await update(serve([publish("0.6.0")]), "0.5.0", installDir);
    expect(readdirSync(installDir)).toEqual([INSTALLED]);
  });

  it("keeps the folder it locks private to whoever installed it", async () => {
    const installDir = join(scratchDirectory(), "nested");
    await update(serve([publish("0.6.0")]), "0.5.0", installDir);
    expect(statSync(installDir).mode & 0o777).toBe(0o700);
  });

  it("leaves the binary runnable by whoever installed it", async () => {
    const installDir = scratchDirectory();
    await update(serve([publish("0.6.0")]), "0.5.0", installDir);
    expect(statSync(join(installDir, INSTALLED)).mode & 0o777).toBe(0o755);
  });

  it("passes over a prerelease", async () => {
    await expect(updateFrom([publish("0.6.0", { prerelease: true })])).resolves.toEqual({
      status: "current",
    });
  });

  it("passes over a draft", async () => {
    await expect(updateFrom([publish("0.6.0", { draft: true })])).resolves.toEqual({
      status: "current",
    });
  });

  it("passes over a release built for another chip", async () => {
    await expect(updateFrom([publish("0.6.0", { arch: "x64" })])).resolves.toEqual({
      status: "current",
    });
  });

  it("passes over a tag the install script would not accept", async () => {
    await expect(updateFrom([publish("v0.6.0")])).resolves.toEqual({ status: "current" });
  });

  it("stands down on a machine with no published build", async () => {
    await expect(
      CODEX.update({
        ...acceptEverything(),
        runtimePlatform: "linux",
        currentVersion: "0.5.0",
        installDir: scratchDirectory(),
        fetchImpl: serve([publish("0.6.0")]),
      }),
    ).resolves.toEqual({ status: "unsupported" });
  });

  it("stands down when it cannot tell what version it is", async () => {
    await expect(updateFrom([publish("0.6.0")], "development")).resolves.toEqual({
      status: "unsupported",
    });
  });

  it("stands aside while another copy is updating", async () => {
    const installDir = scratchDirectory();
    writeFileSync(join(installDir, ".update.lock"), "");
    await expect(update(serve([publish("0.6.0")]), "0.5.0", installDir)).resolves.toEqual({
      status: "busy",
    });
  });

  it("takes over a lock nobody released", async () => {
    const installDir = scratchDirectory();
    writeFileSync(join(installDir, ".update.lock"), "");
    await expect(
      CODEX.update({
        ...acceptEverything(),
        currentVersion: "0.5.0",
        installDir,
        fetchImpl: serve([publish("0.6.0")]),
        now: () => Date.now() + 60 * 60 * 1000,
      }),
    ).resolves.toEqual({ status: "updated", version: "0.6.0" });
  });

  it("frees the lock once it is done", async () => {
    const installDir = scratchDirectory();
    await update(serve([publish("0.6.0")]), "0.5.0", installDir);
    expect(existsSync(join(installDir, ".update.lock"))).toBe(false);
  });

  it("frees the lock when the release list cannot be read", async () => {
    const installDir = scratchDirectory();
    const fetchImpl = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await expect(update(fetchImpl, "0.5.0", installDir)).rejects.toThrow("HTTP 500");
    expect(existsSync(join(installDir, ".update.lock"))).toBe(false);
  });
});

describe("verifying what it downloaded", () => {
  it("refuses a release whose contents do not match its digest", async () => {
    const { message } = await failedUpdate([
      publish("0.6.0", { digest: `sha256:${sha256("something else")}` }),
    ]);
    expect(message).toContain("SHA-256 mismatch");
  });

  it("refuses a release with no digest at all", async () => {
    const { message } = await failedUpdate([publish("0.6.0", { digest: null })]);
    expect(message).toContain("no SHA-256 digest or checksum file");
  });

  it("falls back to the checksum file the release publishes", async () => {
    const body = executableBody("0.6.0");
    await expect(
      updateFrom([
        publish("0.6.0", {
          body,
          digest: null,
          checksum: `${sha256(body)}  langsmith-codex-tracing-darwin-arm64-0.6.0\n`,
        }),
      ]),
    ).resolves.toEqual({ status: "updated", version: "0.6.0" });
  });

  it("refuses a checksum file naming a different asset", async () => {
    const body = executableBody("0.6.0");
    const { message } = await failedUpdate([
      publish("0.6.0", { body, digest: null, checksum: `${sha256(body)}  something-else\n` }),
    ]);
    expect(message).toContain("invalid SHA-256 checksum file");
  });

  it("refuses a download served from somewhere else", async () => {
    const release = publish("0.6.0");
    const asset = (release.json.assets as { browser_download_url: string }[])[0]!;
    asset.browser_download_url = "https://example.invalid/binary";
    const { message } = await failedUpdate([release]);
    expect(message).toContain("unexpected download URL");
  });

  it("refuses a release that claims an absurd size", async () => {
    const release = publish("0.6.0");
    (release.json.assets as { size: number }[])[0]!.size = 900 * 1024 * 1024;
    const { message } = await failedUpdate([release]);
    expect(message).toContain("outside the allowed range");
  });

  it("refuses a download that stops early", async () => {
    const release = publish("0.6.0");
    (release.json.assets as { size: number }[])[0]!.size += 100;
    const { message } = await failedUpdate([release]);
    expect(message).toContain("size mismatch");
  });

  it("stops a download that keeps sending past the size it promised", async () => {
    const release = publish("0.6.0");
    (release.json.assets as { size: number }[])[0]!.size -= 10;
    const { message } = await failedUpdate([release]);
    expect(message).toContain("exceeds its declared size");
  });

  it("refuses a checksum file far too big to be one", async () => {
    const body = executableBody("0.6.0");
    const release = publish("0.6.0", {
      body,
      digest: null,
      checksum: `${sha256(body)}  langsmith-codex-tracing-darwin-arm64-0.6.0\n`,
    });
    (release.json.assets as { size: number }[])[1]!.size = 5000;
    const { message } = await failedUpdate([release]);
    expect(message).toContain("checksum size 5000 is outside the allowed range");
  });

  it("refuses a binary Apple would not vouch for", async () => {
    await expect(
      CODEX.update({
        ...acceptEverything(),
        verifySignature: async () => {
          throw new Error("code object is not signed at all");
        },
        currentVersion: "0.5.0",
        installDir: scratchDirectory(),
        fetchImpl: serve([publish("0.6.0")]),
      }),
    ).rejects.toThrow("not signed");
  });

  it("refuses a binary that reports a different version", async () => {
    const { message } = await failedUpdate([publish("0.6.0", { body: executableBody("9.9.9") })]);
    expect(message).toContain("reports version 9.9.9");
  });

  it("leaves nothing behind when the install fails", async () => {
    const { installDir } = await failedUpdate([
      publish("0.6.0", { digest: `sha256:${sha256("wrong")}` }),
    ]);
    expect(readdirSync(installDir)).toEqual([]);
  });

  it("keeps the working binary when the new one is rejected", async () => {
    const installDir = scratchDirectory();
    const installed = join(installDir, INSTALLED);
    writeFileSync(installed, executableBody("0.5.0"));
    const fetchImpl = serve([publish("0.6.0", { digest: `sha256:${sha256("wrong")}` })]);
    await expect(update(fetchImpl, "0.5.0", installDir)).rejects.toThrow();
    expect(readFileSync(installed, "utf-8")).toBe(executableBody("0.5.0"));
  });
});

describe("installing for the first time", () => {
  it("takes the newest published release", async () => {
    await expect(
      CODEX.install({
        ...acceptEverything(),
        installDir: scratchDirectory(),
        fetchImpl: serve([publish("0.4.0"), publish("0.6.0")]),
      }),
    ).resolves.toMatchObject({ version: "0.6.0" });
  });

  it("takes a prerelease when it is asked for by name", async () => {
    await expect(
      CODEX.install({
        ...acceptEverything(),
        installDir: scratchDirectory(),
        fetchImpl: serve([publish("0.7.0-beta.1", { prerelease: true })]),
        tag: "0.7.0-beta.1",
      }),
    ).resolves.toMatchObject({ version: "0.7.0-beta.1" });
  });

  it("says so when the release it was asked for is not published", async () => {
    await expect(
      CODEX.install({
        ...acceptEverything(),
        installDir: scratchDirectory(),
        fetchImpl: serve([], undefined),
        tag: "9.9.9",
      }),
    ).rejects.toThrow("HTTP 404");
  });

  it("makes the new install folder private to whoever installed it", async () => {
    const installDir = join(scratchDirectory(), "nested");
    await CODEX.install({
      ...acceptEverything(),
      installDir,
      fetchImpl: serve([publish("0.6.0")]),
    });
    expect(statSync(installDir).mode & 0o777).toBe(0o700);
  });

  it("refuses a draft even when it is asked for by name", async () => {
    await expect(
      CODEX.install({
        ...acceptEverything(),
        installDir: scratchDirectory(),
        fetchImpl: serve([publish("0.7.0", { draft: true })]),
        tag: "0.7.0",
      }),
    ).rejects.toThrow("no published release tagged 0.7.0");
  });

  it("refuses a tag the install script would not accept", async () => {
    await expect(
      CODEX.install({
        ...acceptEverything(),
        installDir: scratchDirectory(),
        fetchImpl: serve([publish("v0.6.0")]),
        tag: "v0.6.0",
      }),
    ).rejects.toThrow("no published release tagged v0.6.0");
  });

  it("stands down on a machine with no published build", async () => {
    await expect(
      CODEX.install({
        ...acceptEverything(),
        runtimePlatform: "linux",
        installDir: scratchDirectory(),
        fetchImpl: serve([publish("0.6.0")]),
      }),
    ).rejects.toThrow("does not run on linux-arm64");
  });

  it("will not copy a running binary onto a machine with no published build", async () => {
    const running = join(scratchDirectory(), "downloaded");
    writeFileSync(running, executableBody("0.6.0"));
    await expect(
      CODEX.installLocalCopy(running, "0.6.0", {
        ...acceptEverything(),
        runtimePlatform: "linux",
        installDir: scratchDirectory(),
      }),
    ).rejects.toThrow("does not run on linux-arm64");
  });

  it("says so when nothing published runs on this machine", async () => {
    await expect(
      CODEX.install({
        ...acceptEverything(),
        installDir: scratchDirectory(),
        fetchImpl: serve([publish("0.6.0", { arch: "x64" })]),
      }),
    ).rejects.toThrow("no published release carries a darwin-arm64 binary");
  });

  it("copies the binary that is already running", async () => {
    const installDir = scratchDirectory();
    const running = join(scratchDirectory(), "downloaded");
    writeFileSync(running, executableBody("0.6.0"));
    chmodSync(running, 0o755);
    await expect(
      CODEX.installLocalCopy(running, "0.6.0", { ...acceptEverything(), installDir }),
    ).resolves.toMatchObject({ version: "0.6.0" });
    expect(existsSync(join(installDir, INSTALLED))).toBe(true);
  });

  it("refuses to copy a binary whose version does not match", async () => {
    const running = join(scratchDirectory(), "downloaded");
    writeFileSync(running, executableBody("0.1.0"));
    chmodSync(running, 0o755);
    await expect(
      CODEX.installLocalCopy(running, "0.6.0", {
        ...acceptEverything(),
        installDir: scratchDirectory(),
      }),
    ).rejects.toThrow("reports version 0.1.0");
  });
});

describe("choosing which releases API to read", () => {
  const base = { ...acceptEverything(), currentVersion: "0.5.0" };

  it("asks GitHub for a full page of releases", async () => {
    await expect(firstRequestFor({ ...base, installDir: scratchDirectory() })).resolves.toBe(
      `${RELEASES_API}?per_page=100`,
    );
  });

  it("ignores an override pointing away from this machine", async () => {
    await expect(
      firstRequestFor({
        ...base,
        installDir: scratchDirectory(),
        environment: { LANGSMITH_CODEX_RELEASES_API: "https://evil.invalid/releases" },
      }),
    ).resolves.toBe(`${RELEASES_API}?per_page=100`);
  });

  it("honours an override pointing at this machine", async () => {
    await expect(
      firstRequestFor({
        ...base,
        installDir: scratchDirectory(),
        environment: { LANGSMITH_CODEX_RELEASES_API: "http://localhost:8080/releases" },
      }),
    ).resolves.toBe("http://localhost:8080/releases?per_page=100");
  });
});

describe("the contract installed binaries already depend on", () => {
  it("keeps the asset name the install script downloads", () => {
    expect(CODEX.assetName("darwin", "arm64", "0.6.0")).toBe(
      "langsmith-codex-tracing-darwin-arm64-0.6.0",
    );
  });

  it("keeps updating both the Apple and the Intel Macs it already ships to", () => {
    expect(CODEX.supportsHost("darwin", "arm64")).toBe(true);
    expect(CODEX.supportsHost("darwin", "x64")).toBe(true);
  });

  it("keeps the install directory", () => {
    expect(CODEX.installedBinaryPath("/home/someone")).toBe(
      `/home/someone/.langsmith/${INSTALLED}`,
    );
  });

  it("only treats the installed path as itself", async () => {
    const home = scratchDirectory();
    const stray = join(scratchDirectory(), "stray");
    writeFileSync(stray, executableBody("0.6.0"));
    await expect(CODEX.isInstalledBinary(stray, home)).resolves.toBe(false);
  });

  it("recognises the installed binary", async () => {
    const home = scratchDirectory();
    await CODEX.installLocalCopy(
      (() => {
        const running = join(scratchDirectory(), "downloaded");
        writeFileSync(running, executableBody("0.6.0"));
        chmodSync(running, 0o755);
        return running;
      })(),
      "0.6.0",
      { ...acceptEverything(), home },
    );
    await expect(CODEX.isInstalledBinary(CODEX.installedBinaryPath(home), home)).resolves.toBe(
      true,
    );
  });
});
