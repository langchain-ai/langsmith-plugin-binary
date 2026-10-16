import { writeFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { CaptureScope } from "../../storage/capture/models.js";
import { eventPath } from "../../storage/capture/paths.js";
import { UNUSED_ENDPOINT } from "../../test-support/constants.js";
import { temporaryRoot } from "../../test-support/tracing/delivery.js";
import {
  captureScope,
  runPatch,
  runPost,
  save,
  testBridge,
  turnEvidence,
} from "../../test-support/tracing/lifecycle.js";

const listing = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../utils/files/private-directory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/files/private-directory.js")>();
  return {
    ...actual,
    listPrivateDirectory: (...args: Parameters<typeof actual.listPrivateDirectory>) => {
      listing.calls += 1;
      return actual.listPrivateDirectory(...args);
    },
  };
});

const ROOT = captureScope("session-1", "turn", "root");
let root: string;

beforeEach(() => {
  root = temporaryRoot();
  listing.calls = 0;
});

async function saveChildNaming(named: CaptureScope[], beforeChild: () => void = () => undefined) {
  const lifecycle = testBridge(root, UNUSED_ENDPOINT);
  await save(lifecycle, "turn", "root", runPost("root"), turnEvidence("open", []));
  await save(lifecycle, "turn", "sibling", runPost("sibling"), turnEvidence("open"));
  await save(
    lifecycle,
    "turn",
    "root-end",
    runPatch("root", { end_time: "2026-10-10T12:00:01.000Z" }),
    turnEvidence("open", []),
  );
  beforeChild();
  listing.calls = 0;
  const result = await save(
    lifecycle,
    "turn",
    "child",
    runPost("child"),
    turnEvidence("open"),
    named,
  );
  const child = await createCaptureStore(root).read(captureScope("session-1", "turn", "child"));
  return { result, dependencies: child?.dependencies };
}

it("skips the search when the child names its parent's saved item", async () => {
  await expect(saveChildNaming([ROOT])).resolves.toMatchObject({ dependencies: [ROOT] });
  expect(listing.calls).toBe(0);
});

it("still finds the parent when the named item belongs to another run", async () => {
  const sibling = captureScope("session-1", "turn", "sibling");
  await expect(saveChildNaming([sibling])).resolves.toMatchObject({
    dependencies: [sibling, ROOT],
  });
});

it("still finds the parent when the named item is the parent's update, not its first save", async () => {
  const update = captureScope("session-1", "turn", "root-end");
  await expect(saveChildNaming([update])).resolves.toMatchObject({
    dependencies: [update, ROOT],
  });
});

it("still saves a child whose named parent item can't be read", async () => {
  const saved = await saveChildNaming([ROOT], () =>
    writeFileSync(eventPath(root, ROOT), "{not json"),
  );
  expect(saved.result).toMatchObject({ status: "published" });
});
