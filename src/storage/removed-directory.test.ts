import { existsSync, mkdtempSync, readdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { withFileLock } from "./file-lock.js";
import { ensurePrivateDirectory } from "./capture/utils/atomic-file.js";
import { createCaptureStore } from "./capture/capture-store.js";

const fault = vi.hoisted(() => ({ removeBeforeChmod: "", removeBeforeOpen: "", failMkdir: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (String(args[0]) === fault.failMkdir) {
        fault.failMkdir = "";
        throw Object.assign(new Error("removed while being created"), { code: "ENOENT" });
      }
      return actual.mkdir(...args);
    },
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (String(args[0]) === fault.removeBeforeChmod) {
        fault.removeBeforeChmod = "";
        await actual.rmdir(String(args[0]));
      }
      return actual.chmod(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const directory = dirname(String(args[0]));
      if (fault.removeBeforeOpen !== "" && directory.includes(fault.removeBeforeOpen)) {
        fault.removeBeforeOpen = "";
        await actual.rmdir(directory);
      }
      return actual.open(...args);
    },
  };
});

beforeEach(() => {
  fault.removeBeforeChmod = "";
  fault.removeBeforeOpen = "";
  fault.failMkdir = "";
});

it("takes a lock whose claims directory a cleanup removes during setup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plugins-base-removed-claims-"));
  const path = join(directory, "state.lock");
  fault.removeBeforeChmod = `${path}.claims`;
  try {
    await expect(withFileLock(path, () => "held")).resolves.toBe("held");
    expect(fault.removeBeforeChmod).toBe("");
  } finally {
    if (existsSync(`${path}.claims`)) rmdirSync(`${path}.claims`);
    rmdirSync(directory);
  }
});

it("takes a lock when a cleanup removes the claims directory just as it is being created", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plugins-base-removed-claims-"));
  const path = join(directory, "state.lock");
  fault.failMkdir = `${path}.claims`;
  try {
    await expect(withFileLock(path, () => "held")).resolves.toBe("held");
    expect(fault.failMkdir).toBe("");
  } finally {
    if (existsSync(`${path}.claims`)) rmdirSync(`${path}.claims`);
    rmdirSync(directory);
  }
});

it("creates a private directory that a cleanup removes during setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugins-base-removed-private-"));
  fault.removeBeforeChmod = join(root, "sessions");
  try {
    await expect(ensurePrivateDirectory(root, ["sessions", "turn"])).resolves.toBe(
      join(root, "sessions", "turn"),
    );
    expect(fault.removeBeforeChmod).toBe("");
    expect(readdirSync(join(root, "sessions"))).toEqual(["turn"]);
  } finally {
    rmdirSync(join(root, "sessions", "turn"));
    rmdirSync(join(root, "sessions"));
    rmdirSync(root);
  }
});

it("saves a capture whose folders a removal deletes mid-write", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugins-base-removed-capture-"));
  const store = createCaptureStore(root);
  const scope = { integration: "claude-code", sessionId: "s", turnId: "t", eventId: "e" };
  fault.removeBeforeOpen = `${sep}events`;
  const captured = await store.capture({
    ...scope,
    runId: "r",
    destinationFingerprint: "account-a",
    eventKind: "run-post",
    normalizedPayload: {},
    turnEvidence: {},
    metadataProvenance: {},
  });
  expect(captured.status).toBe("published");
  expect(fault.removeBeforeOpen).toBe("");
  await expect(store.read(scope)).resolves.toMatchObject({ eventId: "e" });
});
