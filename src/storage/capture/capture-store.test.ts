import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  childEnvironment,
  execFileAsync,
  exitCode,
  moduleUrl,
  temporaryRoot,
} from "../../test-support/tracing/delivery.js";
import { createCaptureStore } from "./capture-store.js";
import type { CaptureInput } from "./models.js";
import { eventPath, identifierHash } from "./paths.js";
import { ensurePrivateDirectory } from "./utils/atomic-file.js";

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

function createDirectoryLink(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

async function runCaptureChild(root: string, input: CaptureInput): Promise<string> {
  const inputArg = Buffer.from(JSON.stringify(input)).toString("base64");
  const url = moduleUrl("dist/storage/capture/index.js");
  const result = await execFileAsync(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/capture-worker.mjs", import.meta.url)), url, inputArg, root],
    {
      env: childEnvironment(process.env.HOME ?? tmpdir()),
      timeout: 10_000,
    },
  );
  return result.stdout.trim();
}

describe("immutable capture storage", () => {
  it("rejects invalid imported timing before writing and after reload", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = {
      ...captureInput(),
      sourceAgeStartedAtMs: 123,
    };
    for (const sourceAgeStartedAtMs of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "123"]) {
      await expect(
        store.capture({ ...input, sourceAgeStartedAtMs } as CaptureInput),
      ).resolves.toMatchObject({ status: "failed", code: "SERIALIZATION_FAILED" });
    }
    await expect(store.enumerate(input.integration, input.sessionId)).resolves.toEqual([]);
    await expect(store.capture(input)).resolves.toMatchObject({ status: "published" });
    const path = eventPath(root, input);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    await expect(store.read(input)).resolves.toMatchObject({ sourceAgeStartedAtMs: 123 });
    writeFileSync(path, JSON.stringify({ ...saved, sourceAgeStartedAtMs: -1 }));
    await expect(store.read(input)).rejects.toThrow("Stored source age");
  });

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

  it("persists optional full-scope dependencies", async () => {
    const store = createCaptureStore(temporaryRoot());
    const input = {
      ...captureInput("child-event"),
      dependencies: [
        {
          integration: "claude-code",
          sessionId: "parent-session",
          turnId: "parent-turn",
          eventId: "parent-event",
        },
      ],
    };
    await expect(store.capture(input)).resolves.toMatchObject({ status: "published" });
    await expect(store.read(input)).resolves.toMatchObject({ dependencies: input.dependencies });
    const legacy = captureInput("legacy-event");
    await expect(store.capture(legacy)).resolves.toMatchObject({ status: "published" });
    await expect(store.read(legacy)).resolves.toMatchObject({ eventId: "legacy-event" });
  });

  it("rejects invalid capture dependencies", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const duplicate = {
      integration: "claude-code",
      sessionId: "parent-session",
      turnId: "parent-turn",
      eventId: "parent-event",
    };
    const invalidInputs = [
      {
        ...captureInput("self-event"),
        dependencies: [
          {
            integration: "claude-code",
            sessionId: "session-1",
            turnId: "turn-1",
            eventId: "self-event",
          },
        ],
      },
      { ...captureInput("duplicate-event"), dependencies: [duplicate, duplicate] },
      {
        ...captureInput("integration-event"),
        dependencies: [{ ...duplicate, integration: "codex" }],
      },
      {
        ...captureInput("identifier-event"),
        dependencies: [{ ...duplicate, eventId: "" }],
      },
      { ...captureInput("shape-event"), dependencies: null as never },
    ];
    for (const input of invalidInputs) {
      await expect(store.capture(input)).resolves.toMatchObject({
        status: "failed",
        code: "SERIALIZATION_FAILED",
      });
    }
    const valid = { ...captureInput("persisted-dependency"), dependencies: [duplicate] };
    await store.capture(valid);
    const path = eventPath(root, valid);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({ ...saved, dependencies: [{ ...duplicate, integration: "codex" }] }),
    );
    await expect(store.read(valid)).rejects.toThrow(
      "Capture dependencies must use the same integration",
    );
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

  it("enumerates committed events with their persisted capture times", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const first = captureInput("native-a");
    const second = { ...captureInput("native-b"), turnId: "turn-2" };
    await store.capture(first);
    await store.capture(second);
    const persisted = (await store.read(first))!;
    utimesSync(eventPath(root, first), new Date(0), new Date(0));
    const entries = await store.enumerate(first.integration, first.sessionId);
    expect(entries.map(({ record }) => record.eventId).toSorted()).toEqual([
      "native-a",
      "native-b",
    ]);
    expect(entries.find(({ record }) => record.eventId === first.eventId)?.capturedAtMs).toBe(
      persisted.capturedAtMs,
    );
    await expect(store.capture(first)).resolves.toMatchObject({
      status: "duplicate",
      record: { capturedAtMs: persisted.capturedAtMs },
    });
  });

  it("enumerates only the requested turn", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const first = captureInput("turn-one-event");
    const otherTurn = { ...captureInput("turn-two-event"), turnId: "turn-2" };
    await store.capture(first);
    await store.capture(otherTurn);
    await expect(
      store.enumerateTurn(first.integration, first.sessionId, first.turnId),
    ).resolves.toMatchObject([{ record: { eventId: first.eventId, runId: first.runId } }]);
    await expect(store.enumerate(first.integration, first.sessionId)).resolves.toHaveLength(2);
  });

  it("discovers session IDs from validated records instead of directory hashes", async () => {
    const store = createCaptureStore(temporaryRoot());
    await store.capture({ ...captureInput("event-a"), sessionId: "actual-session-a" });
    await store.capture({ ...captureInput("event-b"), sessionId: "actual-session-b" });

    const sessions = await store.enumerateSessions("claude-code");

    expect(sessions.map(({ sessionId }) => sessionId)).toEqual([
      "actual-session-a",
      "actual-session-b",
    ]);
    expect(sessions.map(({ captures }) => captures[0]?.record.sessionId)).toEqual([
      "actual-session-a",
      "actual-session-b",
    ]);
  });

  it("skips an empty session directory", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    await mkdir(join(root, "sessions", identifierHash("empty-session")), { recursive: true });

    await expect(store.enumerateSessions("claude-code")).resolves.toEqual([]);
  });

  it("skips a session directory while a capture is still being published", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    await store.capture({ ...captureInput("event-a"), sessionId: "saved-session" });
    const stagingDirectory = await ensurePrivateDirectory(root, [
      "sessions",
      identifierHash("writing-session"),
      "turns",
      identifierHash("turn-1"),
    ]);
    writeFileSync(join(stagingDirectory, ".11111111-1111-4111-8111-111111111111.tmp"), "partial");

    await expect(store.enumerateSessions("claude-code")).resolves.toMatchObject([
      { sessionId: "saved-session" },
    ]);
  });

  it("does not follow a symlinked session directory", async () => {
    const input = captureInput();
    const outsideRoot = temporaryRoot();
    await createCaptureStore(outsideRoot).capture(input);
    const linkedRoot = temporaryRoot();
    const sessionsDirectory = join(linkedRoot, "sessions");
    await mkdir(sessionsDirectory, { recursive: true });
    createDirectoryLink(
      join(outsideRoot, "sessions", identifierHash(input.sessionId)),
      join(sessionsDirectory, identifierHash(input.sessionId)),
    );

    await expect(
      createCaptureStore(linkedRoot).enumerateSessions(input.integration),
    ).resolves.toEqual([]);
  });

  it("removes a record whose session ID does not match its hashed directory", async () => {
    const input = captureInput();
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    await store.capture(input);
    const recordPath = eventPath(root, input);
    const record = (await store.read(input))!;
    writeFileSync(recordPath, JSON.stringify({ ...record, sessionId: "invented-session" }));
    await expect(store.enumerateSessions(input.integration)).resolves.toEqual([]);
    expect(existsSync(recordPath)).toBe(false);
  });

  it("removes a malformed event and ignores files that are not saved events", async () => {
    const root = temporaryRoot();
    const input = captureInput();
    const store = createCaptureStore(root);
    await store.capture(input);
    const record = (await store.read(input))!;
    const kept = { ...input, eventId: "kept" };
    await store.capture(kept);
    writeFileSync(eventPath(root, input), `${JSON.stringify(record).slice(0, 40)}`);
    writeFileSync(join(dirname(eventPath(root, input)), ".DS_Store"), "x");
    writeFileSync(join(dirname(eventPath(root, input)), "notes.txt"), "x");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(store.enumerate(input.integration, input.sessionId)).resolves.toMatchObject([
      { record: { eventId: "kept" } },
    ]);
    expect(existsSync(eventPath(root, input))).toBe(false);
    expect(existsSync(join(dirname(eventPath(root, input)), ".DS_Store"))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    writeFileSync(
      eventPath(root, kept),
      JSON.stringify({ ...(await store.read(kept)), runId: "" }),
    );
    await expect(store.enumerate(input.integration, input.sessionId)).resolves.toEqual([]);
    expect(existsSync(eventPath(root, kept))).toBe(false);
    warn.mockRestore();
  });

  it("leaves a record it cannot judge in place and warns", async () => {
    const root = temporaryRoot();
    const input = captureInput();
    const store = createCaptureStore(root);
    await store.capture(input);
    const path = eventPath(root, input);
    const record = (await store.read(input))!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(path, JSON.stringify({ ...record, version: 3 }));
    await expect(store.enumerate(input.integration, input.sessionId)).resolves.toEqual([]);
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") {
      writeFileSync(path, JSON.stringify(record));
      chmodSync(path, 0o000);
      await expect(store.enumerate(input.integration, input.sessionId)).resolves.toEqual([]);
      expect(existsSync(path)).toBe(true);
      chmodSync(path, 0o600);
    }
    expect(warn).toHaveBeenCalledTimes(process.platform === "win32" ? 1 : 2);
    warn.mockRestore();
  });

  it("rejects symlinked directories during event enumeration", async () => {
    const input = captureInput();
    const outsideRoot = temporaryRoot();
    await createCaptureStore(outsideRoot).capture(input);
    const linkedRoot = temporaryRoot();
    const captureRoot = linkedRoot;

    createDirectoryLink(join(outsideRoot, "sessions"), join(captureRoot, "sessions"));
    await expect(
      createCaptureStore(linkedRoot).enumerate(input.integration, input.sessionId),
    ).rejects.toThrow("Private path contains a non-directory");
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
    await expect(store.readOutcome(input, "destination-a")).resolves.toMatchObject({
      status: "failed",
    });
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

  it("rejects a delivery state that was damaged on disk", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = captureInput();
    await store.capture(input);
    await store.recordOutcome({ ...input, destination: "project-a", outcome: "delivered" });
    const path = eventPath(root, input);
    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      delivery: { outcomes: Record<string, Record<string, unknown>> };
    };
    for (const damage of [{ reason: "" }, { recordedAt: "invalid" }, { outcome: "lost" }]) {
      const outcomes = { "project-a": { ...saved.delivery.outcomes["project-a"], ...damage } };
      writeFileSync(path, JSON.stringify({ ...saved, delivery: { ...saved.delivery, outcomes } }));
      await expect(store.readOutcome(input, "project-a")).resolves.toMatchObject({
        status: "failed",
      });
    }
  });

  it("saves delivery failures per destination inside the saved event", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = captureInput();
    await store.capture(input);
    await store.recordRetry(input, "project-a", { failures: 2, notBeforeMs: 5_000 });
    await store.recordRetry(input, "project-b", { failures: 1, notBeforeMs: 1_000 });
    expect((await store.read(input))?.delivery?.retries).toEqual({
      "project-a": { failures: 2, notBeforeMs: 5_000 },
      "project-b": { failures: 1, notBeforeMs: 1_000 },
    });
    await expect(store.capture(input)).resolves.toMatchObject({ status: "duplicate" });
    expect((await store.read(input))?.delivery?.retries["project-a"]?.failures).toBe(2);
    await expect(
      store.recordRetry({ ...input, eventId: "missing" }, "project-a", {
        failures: 1,
        notBeforeMs: 1,
      }),
    ).rejects.toThrow("disappeared");
  });

  it("keeps one outcome per destination when the same outcome is recorded at once", async () => {
    const store = createCaptureStore(temporaryRoot());
    const input = captureInput();
    await store.capture(input);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        store.recordOutcome({ ...input, destination: "project-a", outcome: "delivered" }),
      ),
    );
    expect(results.filter(({ status }) => status === "recorded")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "duplicate")).toHaveLength(5);
  });

  it("removes a saved event with its empty folders and tolerates a repeat", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = captureInput();
    await store.capture(input);
    await store.remove(input, { forgetTurn: true });
    await store.remove(input, { forgetTurn: true });
    await expect(store.read(input)).resolves.toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
    await expect(store.capture(input)).resolves.toMatchObject({ status: "published" });
  });

  it("keeps a sibling event when another event of the same turn is removed", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    await store.capture(captureInput("first"));
    await store.capture(captureInput("second"));
    await store.remove(captureInput("first"));
    await expect(store.read(captureInput("second"))).resolves.toMatchObject({ eventId: "second" });
  });

  it("saves events while the same turn is being removed", async () => {
    const store = createCaptureStore(temporaryRoot());
    for (let round = 0; round < 10; round += 1) {
      const results = await Promise.all([
        store.capture(captureInput(`kept-${round}`)),
        store
          .capture(captureInput(`gone-${round}`))
          .then(() => store.remove(captureInput(`gone-${round}`))),
      ]);
      expect(results[0]).toMatchObject({ status: "published" });
    }
  }, 60_000);

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
    const integrationParent = root;
    const outside = join(root, "outside");
    await mkdir(integrationParent, { recursive: true });
    await mkdir(outside);
    const outsideMode = lstatSync(outside).mode & 0o777;
    createDirectoryLink(outside, join(integrationParent, "sessions"));
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
    const captureRoot = linkedRoot;

    createDirectoryLink(join(outsideRoot, "sessions"), join(captureRoot, "sessions"));
    await expect(createCaptureStore(linkedRoot).read(input)).rejects.toThrow(
      "Capture path contains a non-directory",
    );
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
      "sessions",
      identifierHash(input.sessionId),
      "turns",
      identifierHash(input.turnId),
    ]);
    const contents = JSON.stringify(input);
    const url = moduleUrl("dist/storage/capture/utils/atomic-file.js");
    const child = await execFileAsync(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/capture-crash-worker.mjs", import.meta.url)),
        url,
        path,
        contents,
      ],
      {
        env: childEnvironment(process.env.HOME ?? tmpdir()),
        timeout: 10_000,
      },
    )
      .then(() => ({ code: 0 }))
      .catch((error: unknown) => ({ code: exitCode(error) }));
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

it("rejects an unsupported storage directory before creating any paths", () => {
  const root = temporaryRoot();
  expect(() => createCaptureStore(root, "../outside" as never)).toThrow(
    "Capture directory must be turns or jobs",
  );
  expect(readdirSync(root)).toEqual([]);
});

it("does not delete another plugin's records when scanning the same storage root", async () => {
  const root = temporaryRoot();
  const store = createCaptureStore(root);
  const input = captureInput();
  await store.capture(input);
  await expect(store.enumerate("codex", input.sessionId)).resolves.toEqual([]);
  await expect(store.read(input)).resolves.toMatchObject({ eventId: input.eventId });
});
