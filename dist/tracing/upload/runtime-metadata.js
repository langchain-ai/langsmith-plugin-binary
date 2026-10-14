import { __version__ } from "langsmith";
import { buildCodingAgentRuntimeMetadata } from "../../metadata/index.js";
import { UPLOAD_BUN_RUNTIME, UPLOAD_NODE_RUNTIME } from "./constants.js";
export function applyRuntimeMetadata(payload, privacyMode) {
    if (privacyMode !== "full")
        return;
    const added = buildCodingAgentRuntimeMetadata({
        env: process.env,
        runtime: "Bun" in globalThis ? UPLOAD_BUN_RUNTIME : UPLOAD_NODE_RUNTIME,
        sdkVersion: __version__,
    });
    const extra = payload.extra ?? {};
    const metadata = { ...added.metadata, ...extra["metadata"] };
    payload.extra = {
        ...extra,
        runtime: { ...added.runtime, ...extra["runtime"] },
        metadata,
    };
}
//# sourceMappingURL=runtime-metadata.js.map