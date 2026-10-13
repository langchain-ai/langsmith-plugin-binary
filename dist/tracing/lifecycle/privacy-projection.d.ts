import { type CodingAgentIntegration, type CodingAgentMetadataOptions } from "../../metadata/index.js";
import { type CodingAgentPrivacyContext, type CodingAgentPrivacyStatus } from "../../privacy/index.js";
import type { NormalizedRunContext, NormalizedRunPatch, NormalizedRunSnapshot } from "../upload/models.js";
export declare function projectPost(run: NormalizedRunSnapshot, metadata: CodingAgentMetadataOptions, status: CodingAgentPrivacyStatus): NormalizedRunSnapshot;
export declare function projectPatch(context: NormalizedRunContext, patch: NormalizedRunPatch, integration: CodingAgentIntegration, metadata: CodingAgentMetadataOptions, privacyContext: CodingAgentPrivacyContext): NormalizedRunPatch;
//# sourceMappingURL=privacy-projection.d.ts.map