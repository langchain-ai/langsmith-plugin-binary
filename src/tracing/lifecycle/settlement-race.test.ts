import { expect, it, vi } from "vitest";
import { temporaryRoot } from "../../test-support/tracing/delivery.js";
import {
  CHILD_ID,
  REPOSITORY,
  captureScope,
  localEndpoint,
  runPatch,
  runPost,
  save,
  turnEvidence,
  testBridge,
} from "../../test-support/tracing/lifecycle.js";
import type { DeliveryCaptureInput } from "../delivery/models.js";
import type { LifecycleBridge, LifecycleDrainResult } from "./models.js";

const hooks = vi.hoisted(() => ({ beforeSettlement: null as null | (() => Promise<void>) }));

vi.mock("../delivery/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../delivery/index.js")>();
  return {
    ...actual,
    createDeliveryCoordinator: vi.fn((options) => {
      const coordinator = actual.createDeliveryCoordinator(options);
      return {
        ...coordinator,
        async capture(input: DeliveryCaptureInput) {
          const hook = hooks.beforeSettlement;
          if (input.eventKind === "run-settlement-patch" && hook !== null) {
            hooks.beforeSettlement = null;
            await hook();
          }
          return coordinator.capture(input);
        },
      };
    }),
  };
});

const branch = (ls_git_branch: string) => ({ base: { ...REPOSITORY, ls_git_branch } });

it("keeps a stale settlement pass from landing after a newer source revision", async () => {
  const endpoint = await localEndpoint();
  const root = temporaryRoot();
  const [bridge, concurrent] = [testBridge(root, endpoint.url), testBridge(root, endpoint.url)];
  const ended = { run: { end_time: "2026-10-10T12:00:02.000Z" } };
  await save(bridge, "turn", "root", runPost("root", { ...branch("main"), ...ended }));
  await save(bridge, "turn", "child", runPost("child", ended), undefined, [
    captureScope("session-1", "turn", "root"),
  ]);
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    hooks.beforeSettlement = () => {
      resolve();
      return new Promise((done) => (release = done));
    };
  });
  const stale = bridge.drain();
  await entered;
  const revision = runPatch("root", {}, branch("release"));
  await save(concurrent, "turn", "revision", revision, undefined, [
    captureScope("session-1", "turn", "root"),
  ]);
  await concurrent.drain();
  release();
  await stale;
  await expect(concurrent.drain()).resolves.toMatchObject({ status: "drained" });
  const branches = endpoint.requests
    .filter(({ method, path }) => method === "PATCH" && path.endsWith(CHILD_ID))
    .map(
      ({ payload }) =>
        (payload["extra"] as { metadata: { ls_git_branch?: string } }).metadata.ls_git_branch,
    );
  expect(branches.at(-1)).toBe("release");
  expect(branches.slice(branches.indexOf("release"))).not.toContain("main");
  await endpoint.close();
});

it("releases the settlement lock before a wake drains again", async () => {
  const drains: LifecycleDrainResult[] = [];
  let reenter = false;
  const endpoint = await localEndpoint();
  const lifecycle: LifecycleBridge = testBridge(temporaryRoot(), endpoint.url, {
    wake: async () => {
      if (reenter) drains.push(await lifecycle.drain());
    },
  });
  for (const [eventId, run] of [
    ["root", "root"],
    ["child", "child"],
  ] as const)
    await lifecycle.capture({
      turnId: "turn",
      eventId,
      submission: runPost(run, { run: { end_time: "2026-10-10T12:00:02.000Z" } }),
      turnEvidence: turnEvidence(),
    });
  reenter = true;
  await expect(lifecycle.drain()).resolves.toMatchObject({ status: "drained" });
  expect(drains.map(({ status }) => status)).toEqual(["drained"]);
  await endpoint.close();
});
