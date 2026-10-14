import { createHash } from "node:crypto";
import { canonicalJson } from "./serialization.js";
export function captureContentDigest(record) {
    const content = { ...record };
    delete content.version;
    delete content.capturedAtMs;
    delete content.delivery;
    delete content.destinationRoutes;
    return createHash("sha256").update(canonicalJson(content)).digest("hex");
}
//# sourceMappingURL=digest.js.map