import { existsSync, mkdtempSync, readdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { withFileLock } from "./file-lock.js";
import { ensurePrivateDirectory } from "./capture/utils/atomic-file.js";
import { createCaptureStore } from "./capture/capture-store.js";

const fault = vi.hoisted(() => ({ removeBeforeChmod: "", removeBeforeOpen: "", invalidMkdir: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (String(args[0]) === fault.removeBeforeChmod) {
        fault.removeBeforeChmod = "";
        await actual.rmdir(String(args[0]));
      }
      return actual.chmod(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const directory = String(args[0]).slice(0, String(args[0]).lastIndexOf("/"));
      if (fault.removeBeforeOpen !== "" && directory.includes(fault.removeBeforeOpen)) {
        fault.removeBeforeOpen = "";
        await actual.rmdir(directory);
      }
      return actual.open(...args);
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (fault.invalidMkdir !== "" && String(args[0]).endsWith(fault.invalidMkdir)) {
        fault.invalidMkdir = "";
        throw Object.assign(new Error("injected removal race"), { code: "EINVAL" });
      }
      return actual.mkdir(...args);
    },
  };
});

beforeEach(() => {
  fault.removeBeforeChmod = "";
  fault.removeBeforeOpen = "";
  fault.invalidMkdir = "";
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

it("saves captures and receipts whose folders a cleanup removes mid-write", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugins-base-removed-capture-"));
  const store = createCaptureStore(root);
  const scope = { integration: "claude-code", sessionId: "s", turnId: "t", eventId: "e" };
  fault.removeBeforeOpen = "/events";
  fault.invalidMkdir = "/receipts";
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
  fault.removeBeforeOpen = "/receipts/";
  const outcome = await store.recordOutcome({
    ...scope,
    destination: "primary",
    outcome: "delivered",
  });
  expect(outcome.status).toBe("recorded");
  expect([fault.removeBeforeOpen, fault.invalidMkdir]).toEqual(["", ""]);
});
