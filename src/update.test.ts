import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION_CHECK_BUDGET_MS, VERSION_CHECK_MINIMUM_ATTEMPT_MS } from "./constants.js";
import {
  acceptEverything,
  CODEX,
  executableBody,
  publish,
  recordedPauses,
  recordRequests,
  RELEASES_API,
  scratchDirectory,
  serve,
  sha256,
} from "./test-support.js";
import type { PublishedRelease } from "./test-support.js";
import type { SignatureVerifier, UpdateOptions } from "./models.js";

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

const KILLED = "#!/bin/sh\nkill -9 $$\n";
const HEALTHY = executableBody("0.6.0");
const REJECTED = `.${INSTALLED}.rejected`;

async function installing(body: string, extra: Partial<UpdateOptions> = {}) {
  const installDir = extra.installDir ?? scratchDirectory();
  const started = Date.now();
  const outcome = await CODEX.update({
    ...acceptEverything(),
    currentVersion: "0.5.0",
    installDir,
    fetchImpl: serve([publish("0.6.0", { body })]),
    ...extra,
  }).catch((thrown: Error) => thrown);
  return {
    installDir,
    spent: Date.now() - started,
    message: outcome instanceof Error ? outcome.message : "",
    left: (): string[] => readdirSync(installDir),
  };
}

function runnable(body: string): string {
  const path = join(scratchDirectory(), "downloaded");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function copying(running: string, installDir: string, verifySignature?: SignatureVerifier) {
  return CODEX.installLocalCopy(running, "0.6.0", {
    ...acceptEverything(),
    installDir,
    ...(verifySignature ? { verifySignature } : {}),
  });
}

function countedSignatureLooks(failFrom = Infinity) {
  let seen = 0;
  return {
    verify: async (): Promise<void> => {
      seen += 1;
      if (seen >= failFrom) throw new Error("code object is not signed at all");
    },
    count: () => seen,
  };
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

  it("refuses a release asset that claims to hold nothing at all", async () => {
    const release = publish("0.6.0");
    (release.json.assets as { size: number }[])[0]!.size = 0;
    const { message } = await failedUpdate([release]);
    expect(message).toContain("release asset size 0 is outside the allowed range");
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

  it("says the system killed the binary and leaves it there to look at", async () => {
    const looks = countedSignatureLooks();
    const { installDir, message, left } = await installing(KILLED, {
      verifySignature: looks.verify,
    });
    expect(message).toContain("killed the downloaded binary with SIGKILL");
    expect(message).toContain(join(installDir, REJECTED));
    expect(left()).toEqual([REJECTED]);
    expect(looks.count()).toBe(3);
    expect(VERSION_CHECK_BUDGET_MS).toBeLessThan(20_000);
    expect(VERSION_CHECK_BUDGET_MS).toBeGreaterThan(VERSION_CHECK_MINIMUM_ATTEMPT_MS * 2);
  });

  it("waits longer before each further try", async () => {
    const paused = recordedPauses();
    await installing(KILLED, { pause: paused.pause });
    expect(paused.waits).toEqual([300, 900]);
  });

  const OVERRUNS: ReadonlyArray<readonly [string, string, number, number]> = [
    ["never answers", "#!/bin/sh\nsleep 60\n", 700, 3_000],
    ["refuses to be stopped", "#!/bin/sh\ntrap '' TERM\nsleep 30\n", 700, 5_000],
    [
      "answers late only on a later try",
      `#!/bin/sh\nif [ -f "$0.tried" ]; then sleep 30; fi\ntouch "$0.tried"\nkill -9 $$\n`,
      2_800,
      6_000,
    ],
  ];

  it.each(OVERRUNS)(
    "gives up on a binary that %s",
    async (_why, body, budget, limit) => {
      const { spent, message } = await installing(body, { versionCheckBudget: budget });
      expect(spent).toBeLessThan(limit);
      expect(message).toContain("gave up waiting after");
    },
    30_000,
  );

  it("gives up rather than starting a try it has no time to finish", async () => {
    const looks = countedSignatureLooks();
    const { message } = await installing("#!/bin/sh\nsleep 0.6\nkill -9 $$\n", {
      verifySignature: looks.verify,
      versionCheckBudget: 1_800,
    });
    expect(message).toContain("SIGKILL");
    expect(looks.count()).toBe(1);
  }, 20_000);

  it("really does wait between tries when nobody hands it a clock", async () => {
    const { spent } = await installing(KILLED, { pause: undefined });
    expect(spent).toBeGreaterThanOrEqual(1_200);
  }, 20_000);

  it("does not try a binary that crashed again", async () => {
    const looks = countedSignatureLooks();
    const { message, left } = await installing("#!/bin/sh\nkill -SEGV $$\n", {
      verifySignature: looks.verify,
    });
    expect(message).toContain("crashed with SIGSEGV");
    expect(message).toContain("the program itself failed");
    expect(message).not.toContain("log show");
    expect(looks.count()).toBe(1);
    expect(left()).toEqual([REJECTED]);
  });

  it("keeps one rejected copy at a time and clears it once an install works", async () => {
    const { installDir, left } = await installing(KILLED);
    expect(left()).toEqual([REJECTED]);
    await installing(KILLED, { installDir });
    expect(left()).toEqual([REJECTED]);
    await installing(HEALTHY, { installDir });
    expect(left()).toEqual([INSTALLED]);
  });

  it("points at no kept copy when the download removed itself", async () => {
    const { message, left } = await installing('#!/bin/sh\nrm -f "$0"\nkill -9 $$\n');
    expect(message).not.toContain("is kept at");
    expect(left()).toEqual([]);
  });

  it("clears the download away when it cannot be kept for inspection", async () => {
    const installDir = scratchDirectory();
    mkdirSync(join(installDir, REJECTED), { recursive: true });
    const { message, left } = await installing(KILLED, { installDir });
    expect(message).not.toContain("is kept at");
    expect(left()).toEqual([REJECTED]);
  });

  it("gets past a binary the machine refused to run only the first time", async () => {
    const order = join(scratchDirectory(), "order");
    const { installDir, message } = await installing(
      `#!/bin/sh\necho ran >> ${order}\nif [ -f "$0.tried" ]; then echo 0.6.0; exit 0; fi\ntouch "$0.tried"\nkill -9 $$\n`,
      { verifySignature: async () => appendFileSync(order, "looked\n") },
    );
    expect(message).toBe("");
    expect(existsSync(join(installDir, INSTALLED))).toBe(true);
    expect(readFileSync(order, "utf-8").trim()).toBe("looked\nran\nlooked\nran");
  });

  it("says the file changed when the signature stops matching between tries", async () => {
    const looks = countedSignatureLooks(2);
    const { message, left } = await installing(KILLED, { verifySignature: looks.verify });
    expect(message).toContain("no longer matches the signature we published");
    expect(message).toContain("altered the file after it landed here");
    expect(left()).toEqual([REJECTED]);
  });

  it("throws away a binary that ran and gave up", async () => {
    const looks = countedSignatureLooks();
    const { message, left } = await installing("#!/bin/sh\nexit 3\n", {
      verifySignature: looks.verify,
    });
    expect(message).toContain("exited with code 3");
    expect(looks.count()).toBe(1);
    expect(left()).toEqual([]);
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

  it("never runs the copy it just wrote", async () => {
    const installDir = scratchDirectory();
    const ran = join(scratchDirectory(), "ran");
    await copying(runnable(`#!/bin/sh\ntouch ${ran}\necho 0.6.0\n`), installDir);
    expect(existsSync(ran)).toBe(false);
    expect(readFileSync(join(installDir, INSTALLED), "utf-8")).toContain("echo 0.6.0");
    expect(statSync(join(installDir, INSTALLED)).mode & 0o777).toBe(0o755);
  });

  it("installs a copy the machine would refuse to run", async () => {
    const installDir = scratchDirectory();
    await expect(copying(runnable(KILLED), installDir)).resolves.toMatchObject({
      version: "0.6.0",
    });
    expect(readdirSync(installDir)).toEqual([INSTALLED]);
  });

  it("still looks at the signature of the copy it wrote", async () => {
    const looked: string[] = [];
    await copying(runnable(HEALTHY), scratchDirectory(), async (binary: string) => {
      looked.push(readFileSync(binary, "utf-8"));
    });
    expect(looked).toEqual([HEALTHY]);
  });

  it("throws out a copy that was altered after it was written", async () => {
    const installDir = scratchDirectory();
    await expect(
      copying(runnable(HEALTHY), installDir, async (binary: string) => {
        appendFileSync(binary, "\nrm -rf /\n");
        throw new Error("code object is not signed at all");
      }),
    ).rejects.toThrow("not signed at all");
    expect(readdirSync(installDir)).toEqual([]);
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
