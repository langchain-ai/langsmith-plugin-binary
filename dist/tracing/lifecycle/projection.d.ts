import { type CodingAgentIntegration } from "../../metadata/index.js";
import type { JsonValue } from "../../storage/capture/models.js";
import type { NormalizedRunContext } from "../upload/models.js";
import type { SubmissionProjectionResult } from "./models.js";
export declare function projectSubmission(value: unknown, integration: CodingAgentIntegration, priorIdentity?: NormalizedRunContext): SubmissionProjectionResult;
export declare function projectTurnEvidence(value: unknown, mode: "full" | "metadata", attributionReady: boolean): JsonValue;
//# sourceMappingURL=projection.d.ts.map