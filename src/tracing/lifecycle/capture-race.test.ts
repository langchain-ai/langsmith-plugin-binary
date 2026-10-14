import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { temporaryRoot } from "../../test-support/tracing/delivery.js";
import {
  localEndpoint,
  runPost,
  testBridge,
  turnEvidence,
} from "../../test-support/tracing/lifecycle.js";
import type { DeliveryCaptureInput } from "../delivery/models.js";

const barrier = vi.hoisted(() => ({ waiting: [] as Array<() => void>, expected: 0 }));

vi.mock("../delivery/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../delivery/index.js")>();
  return {
    ...actual,
    createDeliveryCoordinator: vi.fn((options) => {
      const coordinator = actual.createDeliveryCoordinator(options);
      return {
        ...coordinator,
        async capture(input: DeliveryCaptureInput) {
          if (barrier.expected > 0) {
            await new Promise<void>((resolve) => {
              barrier.waiting.push(resolve);
              if (barrier.waiting.length === barrier.expected) {
                barrier.expected = 0;
                for (const release of barrier.waiting.splice(0)) release();
              }
            });
          }
          return coordinator.capture(input);
        },
      };
    }),
  };
});

function unidentified() {
  const submission = runPost("root");
  delete submission.run.start_time;
  delete submission.run.trace_id;
  delete submission.run.dotted_order;
  return submission;
}

function captureInput() {
  return {
    turnId: "turn",
    eventId: "event",
    submission: unidentified(),
    turnEvidence: turnEvidence(),
  };
}

it("lets a capture that lost a race adopt the winner's generated run identity", async () => {
  const endpoint = await localEndpoint();
  const root = temporaryRoot();
  barrier.expected = 2;
  const first = testBridge(root, endpoint.url).capture(captureInput());
  await delay(5);
  const second = testBridge(root, endpoint.url).capture(captureInput());
  const statuses = (await Promise.all([first, second])).map(({ status }) => status);
  expect(statuses.toSorted()).toEqual(["duplicate", "published"]);
  await endpoint.close();
});
