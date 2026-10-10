import { execFile } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createCaptureStore } from "./capture-store.js";
import type { CaptureInput } from "./models.js";
import { eventPath, identifierHash, receiptPath } from "./paths.js";
import { ensurePrivateDirectory } from "./utils/atomic-file.js";

const execFileAsync = promisify(execFile);

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "plugins-base-capture-"));
}

function captureInput(eventId = "native-event-1"): CaptureInput {
  return {
    integration: "claude-code",
    sessionId: "session-1",
    turnId: "turn-1",
    eventId,
    runId: "run-1",
    destinationFingerprint: "destination-a",
    eventKind: "tool-result",
    normalizedPayload: { metadata: { user_id: "anon-17" }, inputs: { command: "ls" } },
    turnEvidence: { childRunIds: ["run-1"], closed: false },
    metadataProvenance: { producer: "caller-supplied", envelope: { version: 1 } },
  };
}

function childEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CI: "1",
  };
}

function moduleUrl(relativePath: string): string {
  return pathToFileURL(join(process.cwd(), relativePath)).href;
}

function createDirectoryLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

async function runCaptureChild(root: string, input: CaptureInput): Promise<string> {
  const inputArg = Buffer.from(JSON.stringify(input)).toString("base64");
  const url = moduleUrl("dist/storage/capture/index.js");
  const script = `const input=JSON.parse(Buffer.from(process.argv[1],"base64").toString());const store=await import(${JSON.stringify(url)});console.log(JSON.stringify(await store.createCaptureStore(process.argv[2]).capture(input)));`;
  const result = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script, inputArg, root],
    {
      env: childEnvironment(),
      timeout: 10_000,
    },
  );
  return result.stdout.trim();
}

describe("immutable capture storage", () => {
  it("keeps event payload and turn evidence together and distinguishes revisions of one run", async () => {
    const store = createCaptureStore(temporaryRoot());
    const first = captureInput("native-start");
    const second = { ...captureInput("native-stop"), eventKind: "authoritative-stop" };
    const results = await Promise.all([store.capture(first), store.capture(second)]);
    expect(results.map((result) => result.status)).toEqual(["published", "published"]);
    await expect(store.read(first)).resolves.toMatchObject({
      runId: "run-1",
      eventId: "native-start",
      eventKind: "tool-result",
      turnEvidence: { childRunIds: ["run-1"], closed: false },
      destinationFingerprint: "destination-a",
      metadataProvenance: { producer: "caller-supplied", envelope: { version: 1 } },
    });
    await expect(store.read(second)).resolves.toMatchObject({
      eventId: "native-stop",
      runId: "run-1",
    });
  });

  it("treats stable replay as duplicate and refuses conflicting content", async () => {
    const store = createCaptureStore(temporaryRoot());
    const input = captureInput();
    await expect(store.capture(input)).resolves.toMatchObject({ status: "published" });
    await expect(store.capture(input)).resolves.toMatchObject({ status: "duplicate" });
    await expect(
      store.capture({
        ...input,
        normalizedPayload: { inputs: { command: "ls" }, metadata: { user_id: "anon-17" } },
      }),
    ).resolves.toMatchObject({ status: "duplicate" });
    await expect(
      store.capture({ ...input, normalizedPayload: { different: true } }),
    ).resolves.toEqual({
      status: "conflict",
    });
    await expect(store.read(input)).resolves.toMatchObject({
      normalizedPayload: input.normalizedPayload,
    });
  });

  it("rejects an invalid destination fingerprint", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = { ...captureInput(), destinationFingerprint: "" };
    await expect(store.capture(input)).resolves.toMatchObject({ status: "failed" });
    await expect(store.read(input)).resolves.toBeUndefined();
  });

  it("rejects persisted identifiers that capture would reject", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = captureInput();
    await store.capture(input);
    const path = eventPath(root, input);
    const original = await store.read(input);
    const invalidFields = [
      ["runId", "Invalid run ID"],
      ["destinationFingerprint", "Invalid destination fingerprint"],
      ["eventKind", "Invalid event kind"],
    ] as const;
    for (const [field, message] of invalidFields) {
      writeFileSync(path, JSON.stringify({ ...original, [field]: "" }));
      await expect(store.read(input)).rejects.toThrow(message);
    }
  });

  it("rejects numeric-looking array properties instead of dropping them", async () => {
    const store = createCaptureStore(temporaryRoot());
    const leadingZero = Object.assign(["first", "second"], { "01": "hidden" });
    const outOfRange = Object.assign([], { "4294967295": "hidden" });
    await expect(
      store.capture({ ...captureInput("leading-zero-array"), normalizedPayload: leadingZero }),
    ).resolves.toMatchObject({ status: "failed", code: "SERIALIZATION_FAILED" });
    await expect(
      store.capture({ ...captureInput("out-of-range-array"), normalizedPayload: outOfRange }),
    ).resolves.toMatchObject({ status: "failed", code: "SERIALIZATION_FAILED" });
  });

  it("returns missing records as undefined and rejects a mismatched stored namespace", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = captureInput();
    const path = eventPath(root, input);
    await expect(store.read(input)).resolves.toBeUndefined();
    await expect(store.capture(input)).resolves.toMatchObject({ status: "published" });
    const record = await store.read(input);
    writeFileSync(path, JSON.stringify({ ...record, sessionId: "another-session" }));
    await expect(store.read(input)).rejects.toThrow("Capture namespace does not match");
  });

  it("keeps each destination pending until its own immutable terminal receipt", async () => {
    const store = createCaptureStore(temporaryRoot());
    const input = captureInput();
    await store.capture(input);
    await expect(store.readOutcome(input, "project-a")).resolves.toEqual({ status: "pending" });
    await expect(store.readOutcome(input, "project-b")).resolves.toEqual({ status: "pending" });
    await expect(
      store.recordOutcome({ ...input, destination: "project-a", outcome: "delivered" }),
    ).resolves.toMatchObject({
      status: "recorded",
      receipt: { outcome: "delivered", destination: "project-a" },
    });
    await expect(
      store.recordOutcome({ ...input, destination: "project-a", outcome: "delivered" }),
    ).resolves.toMatchObject({
      status: "duplicate",
    });
    await expect(
      store.recordOutcome({ ...input, destination: "project-a", outcome: "dropped" }),
    ).resolves.toEqual({
      status: "conflict",
    });
    await expect(store.readOutcome(input, "project-a")).resolves.toMatchObject({
      status: "settled",
      receipt: { outcome: "delivered" },
    });
    await expect(store.readOutcome(input, "project-b")).resolves.toEqual({ status: "pending" });
    await expect(
      store.recordOutcome({
        ...input,
        destination: "project-b",
        outcome: "dropped",
        reason: "expired",
      }),
    ).resolves.toMatchObject({
      status: "recorded",
      receipt: { outcome: "dropped", reason: "expired" },
    });
  });

  it("rejects malformed persisted receipt fields", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = captureInput();
    const destination = "project-a";
    await store.capture(input);
    await store.recordOutcome({
      ...input,
      destination,
      outcome: "delivered",
      reason: "completed",
    });
    const result = await store.readOutcome(input, destination);
    if (result.status !== "settled") throw new Error("Expected a settled receipt");
    const path = receiptPath(root, input, destination);
    const malformedReceipts = [
      { ...result.receipt, reason: "" },
      { ...result.receipt, recordedAt: "invalid" },
    ];
    for (const receipt of malformedReceipts) {
      writeFileSync(path, JSON.stringify(receipt));
      await expect(store.readOutcome(input, destination)).resolves.toMatchObject({
        status: "failed",
      });
    }
  });

  it("reports serialization failures without publishing a partial event", async () => {
    const store = createCaptureStore(temporaryRoot());
    const input = {
      ...captureInput(),
      normalizedPayload: { value: 1n } as unknown as CaptureInput["normalizedPayload"],
    };
    await expect(store.capture(input)).resolves.toMatchObject({
      status: "failed",
      code: "SERIALIZATION_FAILED",
    });
    await expect(store.read(input)).resolves.toBeUndefined();
  });

  it("uses distinct hashed paths for identifiers that would collide under replacement sanitization", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const traversal = captureInput("../a");
    const plain = captureInput("a");
    await expect(store.capture(traversal)).resolves.toMatchObject({ status: "published" });
    await expect(store.capture(plain)).resolves.toMatchObject({ status: "published" });
    expect(eventPath(root, traversal)).not.toBe(eventPath(root, plain));
    expect(identifierHash("../a")).not.toBe(identifierHash("a"));
    expect(await store.read(traversal)).toMatchObject({ eventId: "../a" });
  });

  it("rejects invalid and symlinked namespaces", async () => {
    const root = temporaryRoot();
    await expect(
      createCaptureStore(root).capture({ ...captureInput(), integration: "../escape" }),
    ).resolves.toMatchObject({ status: "failed" });
    const captureRoot = join(root, "capture-v1");
    const integrationParent = join(captureRoot, "integrations");
    const outside = join(root, "outside");
    await mkdir(integrationParent, { recursive: true });
    await mkdir(outside);
    const outsideMode = lstatSync(outside).mode & 0o777;
    createDirectoryLink(outside, join(integrationParent, "claude-code"));
    await expect(createCaptureStore(root).capture(captureInput())).resolves.toMatchObject({
      status: "failed",
    });
    expect(lstatSync(outside).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(lstatSync(outside).mode & 0o777).toBe(outsideMode);
  });

  it("rejects event reads through a symlinked directory", async () => {
    const input = captureInput();
    const outsideRoot = temporaryRoot();
    await createCaptureStore(outsideRoot).capture(input);
    const linkedRoot = temporaryRoot();
    const captureRoot = join(linkedRoot, "capture-v1");
    await mkdir(captureRoot, { mode: 0o700 });
    createDirectoryLink(
      join(outsideRoot, "capture-v1", "integrations"),
      join(captureRoot, "integrations"),
    );
    await expect(createCaptureStore(linkedRoot).read(input)).rejects.toThrow(
      "Capture path contains a non-directory",
    );
  });

  it("rejects outcome reads through a symlinked receipt directory", async () => {
    const input = captureInput();
    const destination = "project-a";
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    await store.capture(input);
    const outsideRoot = temporaryRoot();
    const outsideStore = createCaptureStore(outsideRoot);
    await outsideStore.capture(input);
    await outsideStore.recordOutcome({ ...input, destination, outcome: "delivered" });
    const receiptDirectory = dirname(receiptPath(root, input, destination));
    const receiptsRoot = dirname(receiptDirectory);
    const outsideReceiptsRoot = dirname(dirname(receiptPath(outsideRoot, input, destination)));
    createDirectoryLink(outsideReceiptsRoot, receiptsRoot);
    await expect(store.readOutcome(input, destination)).resolves.toMatchObject({
      status: "failed",
      code: "STORAGE_FAILED",
    });
  });

  it("rejects file links when no-follow flags are unavailable", async () => {
    const root = temporaryRoot();
    const target = join(root, "target.json");
    const link = join(root, "linked.json");
    writeFileSync(target, "{}");
    symlinkSync(target, link, "file");
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: 0 } };
    });
    vi.resetModules();
    try {
      const { readPrivateFile } = await import("./utils/atomic-file.js");
      await expect(readPrivateFile(root, link)).rejects.toThrow(
        "Capture record must be a regular file",
      );
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("stores records in real directories with private modes where supported", async () => {
    const root = join(temporaryRoot(), "new-storage-root");
    const store = createCaptureStore(root);
    const input = captureInput();
    await store.capture(input);
    const path = eventPath(root, input);
    const rootInfo = lstatSync(root);
    const directoryInfo = lstatSync(dirname(path));
    const fileInfo = lstatSync(path);
    expect(rootInfo.isDirectory()).toBe(true);
    expect(directoryInfo.isDirectory()).toBe(true);
    expect(fileInfo.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(rootInfo.mode & 0o777).toBe(0o700);
      expect(directoryInfo.mode & 0o777).toBe(0o700);
      expect(fileInfo.mode & 0o777).toBe(0o600);
    }
  });

  it("lets concurrent processes publish the same event once and rejects a conflicting replay", async () => {
    const root = temporaryRoot();
    const input = captureInput();
    const results = await Promise.all([runCaptureChild(root, input), runCaptureChild(root, input)]);
    expect(results.map((result) => JSON.parse(result).status).toSorted()).toEqual([
      "duplicate",
      "published",
    ]);
    await expect(
      runCaptureChild(root, { ...input, normalizedPayload: { changed: true } }),
    ).resolves.toContain('"status":"conflict"');
    await expect(createCaptureStore(root).read(input)).resolves.toMatchObject({
      normalizedPayload: input.normalizedPayload,
    });
  }, 20_000);

  it("leaves no event file when a process crashes after staging and before atomic publication", async () => {
    const root = temporaryRoot();
    const input = captureInput();
    const path = eventPath(root, input);
    await ensurePrivateDirectory(root, [
      "capture-v1",
      "integrations",
      input.integration,
      "sessions",
      identifierHash(input.sessionId),
      "turns",
      identifierHash(input.turnId),
      "events",
    ]);
    const contents = JSON.stringify(input);
    const url = moduleUrl("dist/storage/capture/utils/atomic-file.js");
    const script = `const file=await import(${JSON.stringify(url)});await file.publishExclusive(process.argv[1],process.argv[2],()=>process.exit(71));`;
    const child = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script, path, contents],
      {
        env: childEnvironment(),
        timeout: 10_000,
      },
    )
      .then(() => ({ code: 0 }))
      .catch((error: unknown) => ({ code: errorCode(error) }));
    expect(child.code).toBe(71);
    expect(() => readFileSync(path)).toThrow();
    await expect(createCaptureStore(root).capture(input)).resolves.toMatchObject({
      status: "published",
    });
    await expect(createCaptureStore(root).read(input)).resolves.toMatchObject({
      eventId: input.eventId,
    });
  }, 20_000);
});

function errorCode(error: unknown): number | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined;
}
