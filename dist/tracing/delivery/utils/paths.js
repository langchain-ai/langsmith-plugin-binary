import { join } from "node:path";
import { identifierHash } from "../../../storage/capture/paths.js";
import { DELIVERY_DIRECTORY } from "../constants.js";
export function attemptSegments(scope, destination) {
    return [
        DELIVERY_DIRECTORY,
        "integrations",
        scope.integration,
        "sessions",
        identifierHash(scope.sessionId),
        "turns",
        identifierHash(scope.turnId),
        "events",
        identifierHash(scope.eventId),
        "destinations",
        identifierHash(destination),
        "attempts",
    ];
}
export function attemptDirectory(root, scope, destination) {
    return join(root, ...attemptSegments(scope, destination));
}
//# sourceMappingURL=paths.js.map