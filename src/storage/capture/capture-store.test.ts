import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createCaptureStore } from "./capture-store.js";
import { CAPTURE_RECONSTRUCTION_JOB_KIND } from "./constants.js";
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

function compactableRunInput(
  eventId: string,
  eventKind: "run-post" | "run-patch" = "run-post",
): CaptureInput {
  return {
    ...captureInput(eventId),
    runId: "run-compactable",
    eventKind,
    normalizedPayload:
      eventKind === "run-post"
        ? {
            operation: "post",
            integration: "claude-code",
            privacyMode: "full",
            run: {
              id: "run-compactable",
              name: "compactable",
              run_type: "chain",
              inputs: { prompt: "i".repeat(40_000) },
              outputs: { answer: "o".repeat(40_000) },
            },
          }
        : {
            operation: "patch",
            integration: "claude-code",
            privacyMode: "full",
            run: { id: "run-compactable", name: "compactable", run_type: "chain" },
            privacyContext: { status: "completed" },
            patch: {
              fields: ["outputs", "end_time"],
              values: { outputs: { answer: "o".repeat(40_000) }, end_time: 123 },
            },
          },
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
  it("rejects invalid imported delivery failure counts before writing and after reload", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = { ...captureInput(), priorDeliveryAttempts: 2 };
    for (const priorDeliveryAttempts of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "2"]) {
      await expect(
        store.capture({ ...input, priorDeliveryAttempts } as CaptureInput),
      ).resolves.toMatchObject({ status: "failed", code: "SERIALIZATION_FAILED" });
    }
    await expect(store.enumerate(input.integration, input.sessionId)).resolves.toEqual([]);
    await expect(store.capture(input)).resolves.toMatchObject({ status: "published" });
    const path = eventPath(root, input);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...saved, priorDeliveryAttempts: -1 }));
    await expect(store.read(input)).rejects.toThrow("prior delivery attempts");
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
    const store = createCaptureStore(temporaryRoot());
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

  it("compacts run payload values while retaining immutable replay identity", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = compactableRunInput("compact-post");
    await expect(store.capture(input)).resolves.toMatchObject({ status: "published" });
    const original = (await store.read(input))!;
    const path = eventPath(root, input);
    const originalSize = readFileSync(path).byteLength;

    await expect(store.compact(input, original)).resolves.toMatchObject({
      status: "compacted",
      record: {
        version: 3,
        compaction: {
          version: 1,
          originalContentDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          fields: {
            inputs: { state: "value", digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
            outputs: { state: "value", digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
          },
        },
      },
    });
    const compacted = (await store.read(input))!;
    expect(compacted.normalizedPayload).not.toHaveProperty("run.inputs");
    expect(compacted.normalizedPayload).not.toHaveProperty("run.outputs");
    expect(readFileSync(path).byteLength).toBeLessThan(originalSize);
    await expect(store.capture(input)).resolves.toMatchObject({
      status: "duplicate",
      record: {
        compaction: { originalContentDigest: compacted.compaction?.originalContentDigest },
      },
    });
    await expect(
      store.capture({ ...input, normalizedPayload: { operation: "post", changed: true } }),
    ).resolves.toEqual({ status: "conflict" });
  });

  it("keeps reconstruction snapshots when a delivered receipt has the wrong scope", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input: CaptureInput = {
      ...captureInput("reconstruction-cleanup-scope"),
      runId: "reconstruction:run",
      eventKind: CAPTURE_RECONSTRUCTION_JOB_KIND,
      normalizedPayload: { sourceSnapshots: [{ sourceRef: "source" }] },
    };
    await store.capture(input);
    const original = (await store.read(input))!;
    await store.recordOutcome({ ...input, destination: "destination-a", outcome: "delivered" });
    const path = receiptPath(root, input, "destination-a");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    receipt.sessionId = "another-session";
    writeFileSync(path, JSON.stringify(receipt));

    await expect(store.compactReconstructionJob(input, original, "destination-a")).resolves.toEqual(
      { status: "not-delivered" },
    );
    await expect(store.read(input)).resolves.toMatchObject({
      normalizedPayload: { sourceSnapshots: [{ sourceRef: "source" }] },
    });
  });

  it("compacts only present patch values and preserves non-payload patch fields", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = compactableRunInput("compact-patch", "run-patch");
    await store.capture(input);
    const original = (await store.read(input))!;
    await expect(store.compact(input, original)).resolves.toMatchObject({
      status: "compacted",
      record: {
        normalizedPayload: { patch: { fields: ["end_time"], values: { end_time: 123 } } },
        compaction: {
          fields: {
            inputs: { state: "absent" },
            outputs: { state: "value" },
          },
        },
      },
    });
  });

  it("rejects malformed compacted field markers and leaves unrelated records unchanged", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = compactableRunInput("compact-malformed");
    await store.capture(input);
    const original = (await store.read(input))!;
    await store.compact(input, original);
    const path = eventPath(root, input);
    const compacted = JSON.parse(readFileSync(path, "utf8"));
    compacted.compaction.fields.inputs.digest = "bad";
    writeFileSync(path, JSON.stringify(compacted));
    await expect(store.read(input)).rejects.toThrow("Invalid compacted capture field");

    const unrelated = captureInput("unrelated-kind");
    await store.capture(unrelated);
    const record = (await store.read(unrelated))!;
    await expect(store.compact(unrelated, record)).resolves.toEqual({ status: "changed" });
    await expect(store.read(unrelated)).resolves.toMatchObject({ version: 2 });
  });

  it("lets reads observe either side of an atomic compaction and keeps one receipt per record", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const input = compactableRunInput("compact-race");
    await store.capture(input);
    const original = (await store.read(input))!;
    const reads = Array.from({ length: 24 }, () => store.read(input));
    const [compaction, ...observed] = await Promise.all([store.compact(input, original), ...reads]);
    expect(compaction.status).toBe("compacted");
    expect(observed).toHaveLength(24);
    expect(observed.every((record) => record?.version === 2 || record?.version === 3)).toBe(true);
    const receipts = await Promise.all([
      store.recordOutcome({ ...input, destination: "project-a", outcome: "delivered" }),
      store.recordOutcome({ ...input, destination: "project-a", outcome: "delivered" }),
    ]);
    expect(receipts).toHaveLength(2);
    expect(receipts.map(({ status }) => status)).toEqual(
      expect.arrayContaining(["duplicate", "recorded"]),
    );
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

  it("enumerates only the requested turn and validates its live event files", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    const first = captureInput("turn-one-event");
    const otherTurn = { ...captureInput("turn-two-event"), turnId: "turn-2" };
    await store.capture(first);
    await store.capture(otherTurn);
    writeFileSync(eventPath(root, otherTurn), "invalid record");

    await expect(
      store.enumerateTurn(first.integration, first.sessionId, first.turnId),
    ).resolves.toMatchObject([{ record: { eventId: first.eventId, runId: first.runId } }]);
    await expect(store.enumerate(first.integration, first.sessionId)).rejects.toThrow();
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
    await mkdir(
      join(
        root,
        "capture-v1",
        "integrations",
        "claude-code",
        "sessions",
        identifierHash("empty-session"),
      ),
      { recursive: true },
    );

    await expect(store.enumerateSessions("claude-code")).resolves.toEqual([]);
  });

  it("skips a session directory while a capture is still being published", async () => {
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    await store.capture({ ...captureInput("event-a"), sessionId: "saved-session" });
    const stagingDirectory = await ensurePrivateDirectory(root, [
      "capture-v1",
      "integrations",
      "claude-code",
      "sessions",
      identifierHash("writing-session"),
      "turns",
      identifierHash("turn-1"),
      "events",
    ]);
    writeFileSync(join(stagingDirectory, ".11111111-1111-4111-8111-111111111111.tmp"), "partial");

    await expect(store.enumerateSessions("claude-code")).resolves.toMatchObject([
      { sessionId: "saved-session" },
    ]);
  });

  it("rejects a symlinked foreign session directory before following it", async () => {
    const input = captureInput();
    const outsideRoot = temporaryRoot();
    await createCaptureStore(outsideRoot).capture(input);
    const linkedRoot = temporaryRoot();
    const sessionsDirectory = join(
      linkedRoot,
      "capture-v1",
      "integrations",
      input.integration,
      "sessions",
    );
    await mkdir(sessionsDirectory, { recursive: true });
    createDirectoryLink(
      join(
        outsideRoot,
        "capture-v1",
        "integrations",
        input.integration,
        "sessions",
        identifierHash(input.sessionId),
      ),
      join(sessionsDirectory, identifierHash(input.sessionId)),
    );

    await expect(
      createCaptureStore(linkedRoot).enumerateSessions(input.integration),
    ).rejects.toThrow("Invalid capture session directory");
  });

  it("rejects a record whose session ID does not match its hashed directory", async () => {
    const input = captureInput();
    const root = temporaryRoot();
    const store = createCaptureStore(root);
    await store.capture(input);
    const recordPath = eventPath(root, input);
    const record = (await store.read(input))!;
    writeFileSync(recordPath, JSON.stringify({ ...record, sessionId: "invented-session" }));
    await expect(store.enumerateSessions(input.integration)).rejects.toThrow(
      "Capture event namespace does not match",
    );
  });

  it("fails enumeration when a committed event is malformed", async () => {
    const root = temporaryRoot();
    const input = captureInput();
    const store = createCaptureStore(root);
    await store.capture(input);
    writeFileSync(eventPath(root, input), JSON.stringify({ version: 1, eventId: input.eventId }));
    await expect(store.enumerate(input.integration, input.sessionId)).rejects.toThrow(
      "Unsupported capture record",
    );
  });

  it("rejects symlinked directories during event enumeration", async () => {
    const input = captureInput();
    const outsideRoot = temporaryRoot();
    await createCaptureStore(outsideRoot).capture(input);
    const linkedRoot = temporaryRoot();
    const captureRoot = join(linkedRoot, "capture-v1");
    await mkdir(captureRoot);
    createDirectoryLink(
      join(outsideRoot, "capture-v1", "integrations"),
      join(captureRoot, "integrations"),
    );
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
