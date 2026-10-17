import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalEndpoint } from "../test-support/models/lifecycle.js";
import { expectNoPathsLeft, temporaryRoot } from "../test-support/tracing/delivery.js";
import {
  ROOT_ID,
  localEndpoint,
  runPost,
  turnEvidence,
  writerFor,
} from "../test-support/tracing/lifecycle.js";
import { resolveUploadDestinationFingerprint } from "../tracing/upload/identity.js";
import type { LangSmithUploadWriterOptions } from "../tracing/upload/models.js";
import { UNAVAILABLE_ACCOUNT_FINGERPRINT } from "./constants.js";
import type { PluginSessionOptions } from "./models.js";
import { openPluginSession } from "./session.js";

let endpoint: LocalEndpoint;
let root: string;

beforeEach(async () => {
  endpoint = await localEndpoint();
  root = temporaryRoot();
});

afterEach(() => endpoint.close());

function open(overrides: Partial<PluginSessionOptions> = {}) {
  const writer = writerFor(endpoint.url);
  return openPluginSession({
    storageRoot: root,
    integration: "claude-code",
    sessionId: "session-1",
    writer,
    currentWriter: () => writer,
    scheduleWake: async () => {
      throw new Error("no worker in this test");
    },
    reconstruct: async () => ({ status: "ready", outputs: [] }),
    ...overrides,
  });
}

const expected = {
  integration: "claude-code" as const,
  sessionId: "session-1",
  accountFingerprint: "stale",
};

it("saves a capture, asks the worker to start for its own session, and delivers it on drain", async () => {
  const scheduleWake = vi
    .fn<(sessionId: string) => Promise<number>>()
    .mockRejectedValue(new Error("stop"));
  const plugin = open({ scheduleWake });
  await plugin.session
    .capture({
      turnId: "turn",
      eventId: "event",
      submission: runPost("root"),
      turnEvidence: turnEvidence("authoritative", [], ROOT_ID),
    })
    .catch(() => undefined);
  expect(scheduleWake).toHaveBeenCalledWith("session-1");
  await expect(plugin.session.drain()).resolves.toBe("completed");
  expect(endpoint.requests.map(({ method }) => method)).toEqual(["POST"]);
  expectNoPathsLeft(root);
});

it("reports the account of the writer it was opened with", () => {
  const writer = writerFor(endpoint.url);
  expect(open({ writer }).fingerprint).toBe(resolveUploadDestinationFingerprint(writer));
  expect(open({ writer, storageRoot: temporaryRoot() }).store).toBeDefined();
});

it("starts the worker for whichever session the callbacks are built for", async () => {
  const scheduleWake = vi.fn(async (_sessionId: string) => 1);
  const callbacks = open({ scheduleWake }).callbacks("older-session");
  await expect(callbacks.scheduleWake()).resolves.toBe(1);
  expect(scheduleWake).toHaveBeenCalledWith("older-session");
});

it("resolves the scope to the account in the current settings", async () => {
  const current = writerFor(endpoint.url, "synthetic-other-key");
  const { resolveScope } = open({ currentWriter: async () => current }).callbacks("session-1");
  await expect(resolveScope(expected)).resolves.toEqual({
    ...expected,
    accountFingerprint: resolveUploadDestinationFingerprint(current),
  });
});

const unusableSettings: [string, () => LangSmithUploadWriterOptions | undefined][] = [
  ["has no settings", () => undefined],
  ["has settings that cannot name an account", () => writerFor(endpoint.url, "")],
];

it.each(unusableSettings)(
  "resolves the scope to an unavailable account when the plugin %s",
  async (_name, current) => {
    const { resolveScope } = open({ currentWriter: current }).callbacks("session-1");
    await expect(resolveScope(expected)).resolves.toMatchObject({
      accountFingerprint: UNAVAILABLE_ACCOUNT_FINGERPRINT,
    });
  },
);

it("lets a failure to read the current settings surface instead of hiding it", async () => {
  const { resolveScope } = open({
    currentWriter: (): never => {
      throw new Error("settings unreadable");
    },
  }).callbacks("session-1");
  await expect(resolveScope(expected)).rejects.toThrow("settings unreadable");
});

it("reports on older sessions after a drain only when asked to", async () => {
  const quiet = open();
  await expect(quiet.session.drain()).resolves.toBe("idle");
  const onRecoveryReport = vi.fn();
  const watching = open({ onRecoveryReport });
  await watching.session.drain();
  expect(onRecoveryReport).toHaveBeenCalledTimes(1);
  expect(onRecoveryReport.mock.calls[0]?.[0]).toMatchObject({ status: "completed" });
});

it("hands saved reconstruction work to the plugin's own rebuild step", async () => {
  const reconstruct = vi.fn<PluginSessionOptions["reconstruct"]>(async (job) => ({
    status: "ready",
    outputs: [
      {
        eventId: `rebuilt-${job.eventId}`,
        submission: runPost("root"),
        turnEvidence: job.turnEvidence,
      },
    ],
  }));
  const plugin = open({ reconstruct });
  await plugin.session
    .queueReconstruction({
      turnId: "turn",
      eventId: "job",
      sourceRefs: ["source-1"],
      privacyMode: "full",
      turnEvidence: { rootRunId: ROOT_ID, childRunIds: [], closureState: "authoritative" },
    })
    .catch(() => undefined);
  await expect(plugin.session.drain()).resolves.toBe("completed");
  expect(reconstruct).toHaveBeenCalledTimes(1);
  expect(endpoint.requests.map(({ method }) => method)).toEqual(["POST"]);
});

it("publishes without waiting for a worker that never starts", async () => {
  const plugin = open({ scheduleWake: async () => 1 });
  const started = Date.now();
  await expect(
    plugin.session.capture({
      turnId: "turn",
      eventId: "event",
      submission: runPost("root"),
      turnEvidence: turnEvidence("authoritative", [], ROOT_ID),
    }),
  ).resolves.toMatchObject({ status: "published" });
  expect(Date.now() - started).toBeLessThan(1_000);
});
