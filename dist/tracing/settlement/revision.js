import { createHash } from "node:crypto";
import { SETTLEMENT_EVENT_ID_PREFIX } from "./constants.js";
import { compareScopes } from "./source-order.js";
export function settlementEventId(turnId, runId, dependencies, rootRunId, childRunIds, attribution) {
    const revision = createHash("sha256")
        .update(JSON.stringify({
        turnId,
        runId,
        rootRunId,
        childRunIds: [...childRunIds].toSorted(),
        dependencies: dependencies.toSorted(compareScopes),
        attribution,
    }))
        .digest("hex");
    return `${SETTLEMENT_EVENT_ID_PREFIX}${revision}`;
}
//# sourceMappingURL=revision.js.map