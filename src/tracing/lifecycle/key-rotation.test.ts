import { afterEach, beforeEach, expect, it } from "vitest";
import type { LocalEndpoint } from "../../test-support/models/lifecycle.js";
import { temporaryRoot } from "../../test-support/tracing/delivery.js";
import {
  localEndpoint,
  runPost,
  save,
  testBridge,
  turnEvidence,
  writerFor,
} from "../../test-support/tracing/lifecycle.js";

let endpoint: LocalEndpoint;

beforeEach(async () => {
  endpoint = await localEndpoint();
});

afterEach(() => endpoint.close());

it("keeps work saved under another API key apart instead of uploading it with the current key", async () => {
  const root = temporaryRoot();
  const before = testBridge(root, endpoint.url);
  await save(before, "turn", "root", runPost("root"), turnEvidence("open", []));
  const requestsBefore = endpoint.requests.length;
  const switched = testBridge(root, endpoint.url, {
    writer: writerFor(endpoint.url, "synthetic-other-key"),
  });
  await expect(switched.drain()).resolves.toMatchObject({ delivered: 0, accountMismatch: 1 });
  expect(endpoint.requests.length).toBe(requestsBefore);
});
