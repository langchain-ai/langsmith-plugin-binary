import { __version__ } from "langsmith";
import { buildCodingAgentRuntimeMetadata } from "../../metadata/index.js";
import type { CodingAgentMetadataMode } from "../../metadata/index.js";
import { UPLOAD_BUN_RUNTIME, UPLOAD_NODE_RUNTIME } from "./constants.js";
import type { RuntimeMetadataPayload } from "./models.js";

export function applyRuntimeMetadata(
  payload: RuntimeMetadataPayload,
  privacyMode: CodingAgentMetadataMode,
): void {
  if (privacyMode !== "full") return;
  const added = buildCodingAgentRuntimeMetadata({
    env: process.env,
    runtime: "Bun" in globalThis ? UPLOAD_BUN_RUNTIME : UPLOAD_NODE_RUNTIME,
    sdkVersion: __version__,
  });
  const extra = payload.extra ?? {};
  const metadata = { ...added.metadata, ...(extra["metadata"] as Record<string, unknown>) };
  payload.extra = {
    ...extra,
    runtime: { ...added.runtime, ...(extra["runtime"] as Record<string, unknown>) },
    metadata,
  };
}
