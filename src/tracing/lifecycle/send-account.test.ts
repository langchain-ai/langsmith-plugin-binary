import { expect, it, vi } from "vitest";
import type { StoredCapture } from "../../storage/capture/models.js";
import { temporaryRoot } from "../../test-support/tracing/delivery.js";
import { localEndpoint, testBridge } from "../../test-support/tracing/lifecycle.js";
import type { DeliveryDestination, DrainOptions } from "../delivery/models.js";

const outcome = vi.hoisted(() => ({ rejection: undefined as unknown }));

vi.mock("../delivery/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../delivery/index.js")>();
  return {
    ...actual,
    createDeliveryCoordinator: vi.fn(() => ({
      capture: vi.fn(),
      async drain({ writer }: DrainOptions) {
        outcome.rejection = await writer
          .sendBatch(
            [{} as StoredCapture],
            writer.destinations[0] as DeliveryDestination,
            "another",
          )
          .catch((error: unknown) => error);
        return {
          status: "drained",
          delivered: 0,
          dropped: 0,
          failed: 0,
          pending: 0,
          accountMismatch: 0,
        };
      },
    })),
  };
});

it("refuses to send saved work for an account other than its own", async () => {
  const endpoint = await localEndpoint();
  await testBridge(temporaryRoot(), endpoint.url).drain();
  expect(outcome.rejection).toEqual(new Error("Upload account changed"));
  expect(endpoint.requests).toEqual([]);
  await endpoint.close();
});
