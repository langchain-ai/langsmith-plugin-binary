import { createHash } from "node:crypto";
import type { CaptureScope } from "../../storage/capture/models.js";
import { SETTLEMENT_EVENT_ID_PREFIX } from "./constants.js";
import { compareScopes } from "./source-order.js";

export function settlementEventId(
  turnId: string,
  runId: string,
  dependencies: readonly CaptureScope[],
  rootRunId: string,
  childRunIds: ReadonlySet<string>,
  attribution: Record<string, string>,
): string {
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        turnId,
        runId,
        rootRunId,
        childRunIds: [...childRunIds].toSorted(),
        dependencies: dependencies.toSorted(compareScopes),
        attribution,
      }),
    )
    .digest("hex");
  return `${SETTLEMENT_EVENT_ID_PREFIX}${revision}`;
}
