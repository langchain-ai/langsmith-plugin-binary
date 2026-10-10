import { expect, it } from "vitest";
import { lifecyclePassResult, reconstructionPassResult } from "./pass-results.js";

it("does not treat deferred or duplicate-only reconstruction as progress", () => {
  expect(
    reconstructionPassResult({
      status: "drained",
      captured: 0,
      deferred: 1,
      failed: 0,
      dropped: 0,
      pending: 1,
      accountMismatch: 0,
    }),
  ).toBe("idle");
  expect(
    reconstructionPassResult({
      status: "drained",
      captured: 0,
      deferred: 0,
      failed: 0,
      dropped: 0,
      pending: 0,
      accountMismatch: 0,
    }),
  ).toBe("idle");
});

it("retries busy drains and loops only after persisted work changes", () => {
  expect(reconstructionPassResult({ status: "busy" })).toBe("retryable-failure");
  expect(
    reconstructionPassResult({
      status: "drained",
      captured: 0,
      deferred: 0,
      failed: 1,
      dropped: 0,
      pending: 1,
      accountMismatch: 0,
    }),
  ).toBe("progressed");
  expect(lifecyclePassResult({ status: "busy", settlement: { captured: 0, turns: [] } })).toBe(
    "retryable-failure",
  );
  expect(
    lifecyclePassResult({
      status: "drained",
      delivered: 0,
      dropped: 0,
      failed: 0,
      pending: 0,
      accountMismatch: 0,
      settlement: { captured: 0, turns: [] },
    }),
  ).toBe("idle");
});
